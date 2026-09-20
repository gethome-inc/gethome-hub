import { isIP } from 'node:net';

/**
 * Which `Host` this hub will answer to, and why it has to ask at all.
 *
 * **The attack this closes is DNS rebinding.** Every route but `GET /hub` and
 * `POST /pair` is behind a bearer token, and no browser can attach one
 * cross-origin: there are no cookies here, so a hostile page has no ambient
 * authority to borrow, and asking for an `Authorization` header triggers a
 * preflight this API answers with a 404. That is the whole of why no CORS
 * plugin is registered — the absence *is* the policy.
 *
 * Rebinding walks past all of it by making the browser believe the hub is the
 * attacker's own origin. A page on `evil.com` is served from a name whose DNS
 * record flips to `192.168.1.50` a second later; the browser re-resolves,
 * connects to the hub, and — because the origin is still `evil.com` — hands
 * the page the response. No token is involved, so nothing about the token
 * scheme helps. What it yields is bounded (a public `GET /hub`, and `/pair`
 * guesses against the rate limit in `server.ts`) but it is free reconnaissance
 * from any browser in the house, and the `Host` header is the one place the
 * lie is visible: the browser faithfully sends the name it thinks it dialled.
 *
 * **So the rule is about names, not addresses.** An attacker needs a name they
 * control, which means a registrable public domain. Everything a hub is
 * legitimately reached by is something else:
 *
 *  - an **address**, which is what both apps use when they connect directly —
 *    a page cannot rebind onto a literal, because the browser resolved nothing;
 *  - **`localhost`**, which is `install.sh`'s health check and the one
 *    `update-runner.sh` polls;
 *  - a **single label** (`raspberrypi`), which no public zone can be;
 *  - a **local suffix** — `.local` above all, since mDNS is how the apps find
 *    the hub in the first place.
 *
 * None of those can be pointed at somebody else's LAN, so all of them pass and
 * no client had to change to keep working.
 *
 * **A missing `Host` passes too**, which looks like a hole and is not: HTTP/1.1
 * requires one and every browser sends one, so its absence marks a client that
 * is not a browser and cannot be the attack. Refusing it would only break the
 * odd HTTP/1.0 probe for nothing.
 *
 * The escape hatch is `EXTRA_ALLOWED_HOSTS`, for the one arrangement this
 * cannot recognise: a real domain resolved to a LAN address by a resolver
 * inside the house. `*` turns the check off for somebody who has put the hub
 * behind a proxy and means it.
 */

/**
 * Name suffixes that cannot be registered in the public DNS, so a browser can
 * never be told one of them belongs to an attacker.
 *
 * `.local` is mDNS (RFC 6762) and the one that carries the product. `.home.arpa`
 * is what RFC 8375 actually reserves for home networks; `.home`, `.lan` and the
 * rest are what routers hand out in practice regardless, which is the list that
 * matters for not breaking somebody's hub. Both `.home` and `.home.arpa` are
 * named because neither is a suffix of the other.
 */
const LOCAL_SUFFIXES = [
  '.local',
  '.localhost',
  '.localdomain',
  '.home',
  '.home.arpa',
  '.lan',
  '.internal',
  '.intranet',
  '.private',
] as const;

/**
 * The name out of a `Host` header, without its port and without the trailing
 * dot a fully-qualified name may carry.
 *
 * Three shapes, and the bare IPv6 is the one worth spelling out: `[::1]:8420`
 * brackets its address, `192.168.1.50:8420` has exactly one colon, and `::1`
 * on its own has several and no port at all. Splitting on the last colon —
 * which is what the integrator-facing helper in `core/mqtt-access.ts` does,
 * correctly, for a header that has already been through a browser — would read
 * `::1` as the host `:` on port `1`. Here that matters: a host this cannot
 * parse is a host this would refuse.
 */
export function hostnameFromHeader(header: string | undefined): string {
  const trimmed = (header ?? '').trim().toLowerCase();
  if (trimmed === '') return '';
  let host: string;
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    host = close === -1 ? trimmed.slice(1) : trimmed.slice(1, close);
  } else {
    const first = trimmed.indexOf(':');
    // No colon is a bare name; a second colon means an unbracketed IPv6, which
    // carries no port. Only the single-colon case has one to strip.
    host = first === -1 || trimmed.indexOf(':', first + 1) !== -1 ? trimmed : trimmed.slice(0, first);
  }
  // `hub.local.` and `hub.local` are the same name, and an attacker writing
  // `evil.com.` must not slip past a suffix test by adding a dot.
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

/**
 * Whether this name is one only the local network can mean.
 *
 * Exported because it is the whole of the security argument and wants testing
 * directly, rather than through a server.
 */
export function isLocalHostname(hostname: string): boolean {
  if (hostname === '') return true; // Not a browser — see the note above.
  if (isIP(hostname) !== 0) return true; // An address: nothing was resolved.
  if (hostname === 'localhost') return true;
  if (!hostname.includes('.')) return true; // A single label is not registrable.
  return LOCAL_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

/** Answers whether a request's `Host` is one this hub serves. */
export type HostCheck = (header: string | undefined) => boolean;

/**
 * Build the check, given whatever `EXTRA_ALLOWED_HOSTS` said.
 *
 * Additive on purpose, and named that way in the environment: a list that
 * *replaced* the local rule would be one somebody sets to their own domain and
 * thereby stops their own phone — which reaches the hub by address — from
 * connecting at all. There is no arrangement in which that is what they meant.
 */
export function createHostCheck(extra: string | readonly string[] | undefined): HostCheck {
  const entries = (typeof extra === 'string' ? extra.split(',') : (extra ?? []))
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (entries.includes('*')) return () => true;
  const allowed = new Set(entries);
  return (header) => {
    const hostname = hostnameFromHeader(header);
    return isLocalHostname(hostname) || allowed.has(hostname);
  };
}

/**
 * How many distinct refused names to write to the journal before going quiet.
 *
 * A refusal is the only thing that tells an operator their hub has stopped
 * answering *and why*, so it cannot be silent. But a rebinding attempt is a
 * page in a loop, and one line per request would bury the log it exists to
 * serve on a board whose disk is an SD card. One line per name, and a bound on
 * how many names — because the names are the attacker's to invent.
 */
export const REFUSAL_LOG_LIMIT = 20;

/** Remembers which refused names have already been written down. */
export function createRefusalLogGate(limit = REFUSAL_LOG_LIMIT): (hostname: string) => boolean {
  const seen = new Set<string>();
  return (hostname) => {
    if (seen.has(hostname)) return false;
    if (seen.size >= limit) return false;
    seen.add(hostname);
    return true;
  };
}
