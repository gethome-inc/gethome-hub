import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * The one place the hub itself reaches a third-party site, and the guards that
 * make that acceptable.
 *
 * **Why it exists.** The Anthropic loop researches with a server-side
 * `web_fetch`, so `prompts.ts` can name a device's zigbee2mqtt.io page and
 * have the model read it directly — that page is generated from the same
 * zigbee-herdsman-converters definition that produces the payloads this hub
 * receives, so it settles units, ranges and enum values outright. OpenAI's
 * hosted tool set has no fetch, only search, which left that provider guessing
 * from search snippets at exactly the point in a run where a wrong unit gets
 * cached against a device model for ever.
 *
 * **What it costs.** `docs/ai-adaptation.md` used to promise that the hub
 * opens no connection to any third party — only to the provider's API. That
 * promise now reads "and, during a recognition run, to the two documentation
 * hosts named below". Nothing else about it moved: no device data leaves, the
 * URL is about a public device model, and nothing here runs on a hub with no
 * key or outside a run.
 *
 * **Why an allowlist rather than a general fetch.** The URL comes from model
 * output, and the thing performing the request is a box sitting *inside*
 * somebody's home network with an unauthenticated health route of its own. A
 * general fetch tool is therefore a request-forgery primitive pointed at the
 * LAN — `http://192.168.1.1/`, or the hub's own API — dressed up as research.
 * Two hosts is all the research needs, so two hosts is all it gets.
 *
 * Five guards, and each closes a different way past that:
 *
 *  - **https only**, so there is no plaintext hop to redirect.
 *  - **the host is matched exactly**, or as a subdomain with the dot included:
 *    `endsWith('zigbee2mqtt.io')` would also accept `evil-zigbee2mqtt.io`.
 *  - **redirects are followed by hand**, re-checking every hop, because
 *    `fetch` follows them by default and an allowed host that answers `302
 *    http://10.0.0.1/` would otherwise walk straight past the allowlist.
 *  - **the resolved address must be public.** The allowlist is on a *name*,
 *    and a name resolves to whatever the network says — a captive portal or an
 *    overridden resolver can point a public hostname at the LAN. This does not
 *    pretend to close the rebinding race (the connection resolves again), but
 *    it turns "the allowlist is a list of strings" into a check with an actual
 *    address behind it.
 *  - **bounded bytes and one deadline**, so a hostile or merely enormous page
 *    cannot spend the run's memory or its clock.
 *
 * What comes back is untrusted text and is treated as such everywhere it
 * matters: it becomes model input, never hub input, and the only thing a run
 * can ultimately produce is a `MappingDescriptor` that zod validates and the
 * interpreter *interprets* — the hub never executes model output.
 */

/**
 * The hosts a mapping run may read.
 *
 * Both are documentation for the device in hand. `zigbee2mqtt.io` is the
 * generated device page; `raw.githubusercontent.com` is where the converter
 * definition those pages are generated *from* actually lives — `github.com`
 * itself is deliberately absent, because a blob page is a JavaScript shell
 * with the source buried in it, so allowing it would add a host and no
 * information.
 */
export const FETCHABLE_HOSTS = ['zigbee2mqtt.io', 'raw.githubusercontent.com'] as const;

/** Redirect hops. Enough for a canonical-host or trailing-slash bounce; short
 *  enough that a redirect loop is not the run's problem. */
const MAX_HOPS = 3;
/** Bytes read off the wire. A zigbee2mqtt.io device page is a few hundred KB
 *  of markup; a converter source file is smaller. */
const MAX_BYTES = 1_000_000;
/** Characters of extracted text handed to the model. Whole for every device
 *  page seen, and a bound on the one that isn't. */
const MAX_TEXT = 40_000;
const TIMEOUT_MS = 20_000;

export interface FetchedPage {
  ok: boolean;
  /** The page as text, or the reason there is none. Always something the model
   *  can act on — see `refusal`. */
  text: string;
  /** Where the text came from, after redirects. Absent on a refusal. */
  url?: string;
  /** True when the whole page did not fit in `MAX_TEXT`. */
  truncated?: boolean;
}

/**
 * A refusal the model can do something about.
 *
 * The `diagnosis.ts` rule applied to a tool result: "not allowed" leaves a run
 * guessing, while naming the hosts lets it rewrite a `github.com/…/blob/…` URL
 * into the `raw.githubusercontent.com` one that will work — which is the
 * commonest way a run lands here.
 */
function refusal(why: string): FetchedPage {
  return {
    ok: false,
    text:
      `${why} This tool reads documentation only, from ${FETCHABLE_HOSTS.join(' and ')}. ` +
      'Use web_search for anything else — a GitHub blob URL, for instance, has to be rewritten to its ' +
      'raw.githubusercontent.com form before it can be read here.',
  };
}

/** Exactly this host, or a subdomain of it — with the dot, so a name that
 *  merely *ends* in an allowed one does not pass. */
function hostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return FETCHABLE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/**
 * Whether an address is one the hub has no business reaching on the model's
 * say-so: loopback, the private ranges, link-local (including cloud metadata
 * at 169.254.169.254), and the IPv6 equivalents.
 */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local + metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    return false;
  }
  if (family === 6) {
    const v6 = address.toLowerCase();
    if (v6 === '::1' || v6 === '::') return true;
    if (v6.startsWith('fe80') || v6.startsWith('fc') || v6.startsWith('fd')) return true;
    // ::ffff:10.0.0.1 and friends — an IPv4 address wearing a v6 coat.
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true; // unparseable is not a public address
}

/** Resolve a name to addresses. Injectable so the suite is hermetic: a guard
 *  that only works with a working resolver is one CI cannot check offline. */
export type LookupFn = (hostname: string) => Promise<{ address: string }[]>;

const systemLookup: LookupFn = (hostname) => lookup(hostname, { all: true });

/** Does this name resolve somewhere the hub may go? */
async function resolvesPublicly(hostname: string, resolver: LookupFn): Promise<boolean> {
  try {
    const addresses = await resolver(hostname);
    return addresses.length > 0 && addresses.every((entry) => !isPrivateAddress(entry.address));
  } catch {
    return false;
  }
}

/**
 * Fetch one documentation page as text, or say why not.
 *
 * Never throws: this is a tool result handed back to a model mid-run, and a
 * throw here would end a run that has already been paid for. Every failure —
 * a refused host, a 404, a timeout — comes back as `ok: false` with a sentence
 * the model can act on, which is what lets it fall back to search.
 */
export async function fetchDocumentationPage(
  rawUrl: string,
  options?: { signal?: AbortSignal; fetchImpl?: typeof fetch; lookupImpl?: LookupFn },
): Promise<FetchedPage> {
  const doFetch = options?.fetchImpl ?? fetch;
  const resolver = options?.lookupImpl ?? systemLookup;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return refusal(`"${rawUrl.slice(0, 200)}" is not a URL.`);
  }

  const timer = new AbortController();
  const deadline = setTimeout(() => timer.abort(), TIMEOUT_MS);
  const signal = options?.signal
    ? AbortSignal.any([options.signal, timer.signal])
    : timer.signal;

  try {
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      if (url.protocol !== 'https:') return refusal(`${url.protocol}// is not fetched, only https.`);
      if (!hostAllowed(url.hostname)) return refusal(`${url.hostname} is not a host this hub fetches.`);
      if (!(await resolvesPublicly(url.hostname, resolver))) {
        return refusal(`${url.hostname} does not resolve to a public address from this hub.`);
      }

      let response: Response;
      try {
        response = await doFetch(url, {
          // Every hop is re-checked above, so nothing may be followed for us.
          redirect: 'manual',
          signal,
          headers: { accept: 'text/html,text/plain,*/*', 'user-agent': 'GetHomeHub' },
        });
      } catch (error) {
        return refusal(`Could not reach ${url.hostname}: ${(error as Error).message}.`);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return refusal(`${url.href} redirected with no destination.`);
        // Resolved against the current URL, then round the loop — so the new
        // host faces the same allowlist and the same DNS check.
        try {
          url = new URL(location, url);
        } catch {
          return refusal(`${url.href} redirected somewhere unreadable.`);
        }
        continue;
      }

      if (!response.ok) {
        // Worded per status rather than as one sentence covering all of them:
        // a 404 on this tool is *expected* — the hub derives the URL from a
        // model string — and telling a run to search is the right next move,
        // while blaming the name for a 403 or a 502 would send it looking for
        // a page that exists.
        const advice =
          response.status === 404
            ? 'The page may be named differently — search for it instead.'
            : 'That is the site, not the URL. Search instead, or try again once.';
        return { ok: false, text: `${url.href} answered ${response.status}. ${advice}` };
      }

      const body = await readBounded(response);
      // **Only markup gets the tag-stripper.** The other host serves source —
      // a converter definition — and an HTML pass over that eats its `<` and
      // `>` and flattens the indentation for nothing.
      //
      // The header is asked first and the body second, because neither alone
      // is safe in the direction that matters: a server that labels a page
      // `text/plain` would otherwise put raw markup in front of the model,
      // and the failure is silent. Sniffing costs one regex over the first
      // few kilobytes, and the shapes it looks for are ones no converter
      // source contains — `Array<number>` matches none of them.
      const contentType = response.headers.get('content-type') ?? '';
      const isMarkup = /html|xml/i.test(contentType) || looksLikeMarkup(body);
      const text = (isMarkup ? toText(body) : body.trim()).slice(0, MAX_TEXT + 1);
      return {
        ok: true,
        url: url.href,
        text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text,
        ...(text.length > MAX_TEXT ? { truncated: true } : {}),
      };
    }
    return refusal(`${url.href} redirected more than ${MAX_HOPS} times.`);
  } finally {
    clearTimeout(deadline);
  }
}

/** Read at most `MAX_BYTES`, so an enormous page costs a bounded amount of a
 *  415 MB board's memory rather than whatever the server felt like sending. */
async function readBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return await response.text();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    size += value.byteLength;
    if (size >= MAX_BYTES) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

/** Structural HTML, which documentation has and source code does not. */
function looksLikeMarkup(body: string): boolean {
  return /<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<div[\s>]|<p[\s>]|<table[\s>]/i.test(
    body.slice(0, 4000),
  );
}

/**
 * Markup to readable text, with no dependency added for it.
 *
 * These are documentation pages, so the tag soup is the noise and the prose is
 * the signal — and a parser on a Raspberry Pi for two known hosts would be a
 * dependency subtree bought for nothing (every vulnerable package this repo
 * has shipped arrived transitively). Scripts and styles go whole, because
 * their contents are not text; everything else loses its tags and keeps its
 * words.
 */
export function toText(markup: string): string {
  return markup
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Block-level tags become a newline so tables and lists stay readable.
    .replace(/<\/(p|div|tr|li|h[1-6]|section|article|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}
