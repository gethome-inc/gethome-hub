import { createHash, createHmac } from 'node:crypto';
import { networkInterfaces } from 'node:os';

/**
 * A hub proving it is itself, at an address, to an app that already holds one
 * of its tokens — without that app sending the token there first.
 *
 * An app follows a saved hub to a new address when the old one stops
 * answering (a new DHCP lease, or the hub carried to another network). What it
 * finds there is an mDNS record and a public `GET /hub`, and both say whatever
 * whoever answers wants them to: anything on the LAN can announce this hub's
 * id and serve it back. An app that took that at its word would write the
 * impostor's address down and send it the token on its next request — and the
 * window for it opens every time the hub restarts, an update included.
 *
 * So the app asks the new address for proof first, and the proof is keyed by
 * something only the real hub and that app share: the token's sha256, which is
 * all the hub stores of it (`tokens.token_hash`). The app sends a random nonce,
 * the address it dialled and an id for the token (the hash of the hash, which
 * reveals neither), and the hub answers with an HMAC over all three and its own
 * id. Two rules make that a proof rather than a ceremony:
 *
 * - **The hub signs only for an address it has.** Without that, an impostor
 *   relays the app's challenge to the real hub and hands the answer back. With
 *   it, the relayed challenge names the impostor's address, which the real hub
 *   refuses; and if the impostor rewrites it to the real hub's address, the
 *   HMAC covers an address the app never dialled, which the app refuses.
 * - **Nothing secret goes out.** The token id is a one-way function of a
 *   one-way function of 32 random bytes, and the HMAC is over values the
 *   caller chose. A wrong token id, or an address that is not this hub's,
 *   gets one refusal for both, so the route is no oracle for either.
 *
 * It does not stop somebody who can already take over the hub's real address
 * on the LAN, which is outside what plain HTTP behind a router can promise
 * (`docs/security.md`). It stops the cheap version: one announcement and a
 * wait for the next restart.
 */

/** Separates this MAC from any other use of the same key. */
const CONTEXT = 'gethome-hub-proof';

/** The exact bytes the proof covers — mirrored by both apps, byte for byte. */
export function proofMessage(hubId: string, nonce: string, address: string): string {
  return `${CONTEXT}\n${hubId}\n${nonce}\n${address}`;
}

/** The id an app names its token by: sha256 of the raw sha256 of the token. */
export function proofTokenId(tokenHashHex: string): string {
  return createHash('sha256').update(Buffer.from(tokenHashHex, 'hex')).digest('hex');
}

/** HMAC-SHA256 keyed by the token's raw sha256, as lowercase hex. */
export function proveIdentity(tokenHashHex: string, hubId: string, nonce: string, address: string): string {
  return createHmac('sha256', Buffer.from(tokenHashHex, 'hex'))
    .update(proofMessage(hubId, nonce, address), 'utf8')
    .digest('hex');
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/**
 * The host of an `address:port` an app says it dialled, when it is an IPv4
 * literal — the only thing an app follows a hub to, and the only family the
 * API answers on.
 */
export function proofAddressHost(address: string): string | undefined {
  const match = /^([0-9.]+):(\d{1,5})$/.exec(address);
  if (!match) return undefined;
  const [, host, port] = match;
  if (!IPV4.test(host!) || Number(port) < 1 || Number(port) > 65535) return undefined;
  return host;
}

/** Every IPv4 address this machine holds right now. Asked per request: a lease moves. */
export function ownIPv4Addresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4') out.push(entry.address);
    }
  }
  return out;
}
