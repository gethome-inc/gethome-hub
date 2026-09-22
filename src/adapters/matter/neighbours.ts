import { rename, writeFile } from 'node:fs/promises';
import { isIPv6 } from 'node:net';

/**
 * Where every Matter accessory this hub owns can be reached on the link, for
 * the Wi-Fi keep-alive to ask after by unicast.
 *
 * **Finding an accessory again starts with a multicast, and some routers lose
 * most of those.** To send an accessory anything, the kernel first needs its
 * link address, and IPv6 asks for that with a Neighbour Solicitation to a
 * multicast group — through the same 2.4 GHz group queue a TP-Link Archer C6
 * was measured sitting on (openwrt/mt76#598). Measured again for this, on the
 * hub it was found on: the hub's multicast reached its plug 7 times in 30
 * (Neighbour Solicitation, and broadcast ARP the same), its mDNS queries 2 in
 * 30, and the same questions sent by unicast 30 in 30 every time — while a Mac
 * on 5 GHz fared no better at 3 in 30. That plug had been switched off for
 * days; its own uptime put it back on the network at 09:58, and the hub, which
 * retried at the right address every two minutes, reached it at 10:07, when a
 * multicast finally got through. Every retry in between died in neighbour
 * discovery, before a byte of Matter was sent.
 *
 * The keep-alive already asks after a neighbour by unicast at the link address
 * it had — but only one the kernel has seen, for a day, in `/run`. A plug that
 * was off for longer, or any accessory after the hub reboots, was left to
 * multicast. This file is the part the kernel cannot remember and the hub
 * can: every accessory tells its controller its own link-local addresses and
 * link address (General Diagnostics `NetworkInterfaces`), and matter.js keeps
 * that in its cache for as long as the accessory is commissioned. So the hub
 * writes them down, and the keep-alive — which runs as root, validates every
 * line, and never broadcasts — puts each one it has no link address for into
 * PROBE every two minutes, for as long as the file lists it.
 *
 * **Link-local IPv6 only.** It is what Matter on one Wi-Fi runs on, and it is
 * the accessory's for good: derived from its MAC or stable per network. An
 * IPv4 lease is not — it moves to another device while this one is switched
 * off, and seeding it with this one's MAC would send the new owner's traffic
 * here. A Thread interface is skipped too: its address is an 802.15.4 one,
 * reached through a border router rather than on this link.
 *
 * The rules are here rather than in `adapter.ts` for the reason `settling.ts`
 * gives: reading them through the adapter loads `@matter/main`.
 */

/**
 * The file's name in the hub's data directory. `deploy/install.sh` bakes the
 * same path into the keep-alive, and `test/deploy-wifi.test.ts` holds the two
 * together — renaming one side is a keep-alive that quietly reads nothing.
 */
export const MATTER_NEIGHBOURS_FILE = 'matter-neighbours';

/** One address of an accessory on this hub's link, and the link address that answers for it. */
export interface MatterNeighbour {
  /** Link-local IPv6, as the kernel prints it (RFC 5952), with no zone. */
  address: string;
  /** Lowercase, colon-separated, as the kernel prints it. */
  mac: string;
}

/** General Diagnostics `InterfaceTypeEnum.Thread`. */
const THREAD = 4;

/**
 * An accessory's addresses on this link, from what it reports about itself.
 *
 * `interfaces` is the General Diagnostics `NetworkInterfaces` attribute as
 * matter.js decodes it, taken as `unknown` because it comes out of a cache and
 * a malformed entry must cost that entry rather than the hub. `known` is the
 * addresses matter.js has for the node (`commissioning.addresses`), which is
 * where it will actually send: a link-local one is added too, against the
 * accessory's link address when it has exactly one, for an accessory that
 * leaves its own list short. The spec says the list includes the link-local
 * address; this does not depend on every firmware having read that line.
 */
export function neighboursOf(interfaces: unknown, known: readonly string[] = []): MatterNeighbour[] {
  const found = new Map<string, string>();
  const macs = new Set<string>();
  for (const entry of Array.isArray(interfaces) ? interfaces : []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { hardwareAddress, iPv6Addresses, type } = entry as Record<string, unknown>;
    if (type === THREAD) continue;
    const mac = macOf(bytesOf(hardwareAddress));
    if (mac === undefined) continue;
    macs.add(mac);
    for (const raw of Array.isArray(iPv6Addresses) ? iPv6Addresses : []) {
      const address = linkLocal(bytesOf(raw));
      if (address !== undefined && !found.has(address)) found.set(address, mac);
    }
  }
  const [only] = macs;
  if (macs.size === 1 && only !== undefined) {
    for (const text of known) {
      const address = linkLocal(parseIpv6(text));
      if (address !== undefined && !found.has(address)) found.set(address, only);
    }
  }
  return [...found]
    .map(([address, mac]) => ({ address, mac }))
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
}

/** The file's contents: one `address mac` line each, sorted, so an unchanged home is an unchanged file. */
export function formatNeighbours(byNode: ReadonlyMap<string, readonly MatterNeighbour[]>): string {
  const lines = new Map<string, string>();
  for (const neighbours of byNode.values()) {
    for (const { address, mac } of neighbours) {
      if (!lines.has(address)) lines.set(address, `${address} ${mac}`);
    }
  }
  const body = [...lines.values()].sort();
  return [
    '# Written by the GetHome hub: every Matter accessory it owns, at its link address.',
    '# Read by the Wi-Fi keep-alive (deploy/install.sh), which asks for each by unicast.',
    ...body,
    '',
  ].join('\n');
}

/**
 * The file itself, kept in step with the controller.
 *
 * **Nothing is written until every commissioned node has been asked** —
 * `open()` — so the file is never rewritten, on the way up, with fewer
 * accessories than the hub owns, and a controller that owns none still
 * empties a list left over from one that did. After that, every change is
 * written once things have been quiet for a second, and only if the contents
 * changed: a report that repeats an accessory's addresses costs no write.
 *
 * Through a temporary file and a rename, unlike `radio-mode`: that one is one
 * word written in place because a path unit has to notice the write, while
 * this is many lines read every twenty seconds by a loop, and a torn read
 * would be a round with accessories missing from it. A failure is logged and
 * never thrown — the file is an aid to reaching accessories, and nothing in
 * the adapter may stop for it.
 */
export class MatterNeighbourFile {
  private readonly byNode = new Map<string, readonly MatterNeighbour[]>();
  private live = false;
  private written: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly log: { warn: (details: object, message: string) => void },
    private readonly quietMs = 1000,
  ) {}

  /** What the controller knows about one node now. An empty list keeps the node and lists nothing for it. */
  set(nodeId: string, neighbours: readonly MatterNeighbour[]): void {
    this.byNode.set(nodeId, neighbours);
    this.schedule();
  }

  /** A node the hub no longer owns. */
  delete(nodeId: string): void {
    if (this.byNode.delete(nodeId)) this.schedule();
  }

  /** Every commissioned node has been asked; write what they said, and follow every change from here. */
  open(): Promise<void> {
    this.live = true;
    return this.flush();
  }

  /** Write anything outstanding now, and stop following changes. */
  async close(): Promise<void> {
    if (this.live) await this.flush();
    this.live = false;
  }

  /** Write now, if anything changed. Resolves once the write has been made or failed. */
  flush(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.writing = this.writing.then(() => this.write());
    return this.writing;
  }

  private schedule(): void {
    if (!this.live || this.timer !== undefined) return;
    this.timer = setTimeout(() => void this.flush(), this.quietMs);
    this.timer.unref?.();
  }

  private async write(): Promise<void> {
    const contents = formatNeighbours(this.byNode);
    if (contents === this.written) return;
    const temporary = `${this.file}.tmp`;
    try {
      await writeFile(temporary, contents, { mode: 0o644 });
      await rename(temporary, this.file);
      this.written = contents;
    } catch (error) {
      this.log.warn(
        { err: error },
        'Could not record where the Matter accessories are, so one that comes back after a long time off may take a while to be found.',
      );
    }
  }
}

/** matter.js decodes an octet string as a `Uint8Array`; a cache may hand back any view of one. */
function bytesOf(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return undefined;
}

/**
 * A unicast MAC, from a `hardwareAddress`. The spec allows a 48-bit address to
 * be sent as eight bytes with the first two zero, so both shapes count; a
 * 64-bit one that does not start that way is an 802.15.4 address, not a MAC.
 */
function macOf(bytes: Uint8Array | undefined): string | undefined {
  if (bytes === undefined) return undefined;
  const mac = bytes.length === 6 ? bytes : bytes.length === 8 && bytes[0] === 0 && bytes[1] === 0 ? bytes.subarray(2) : undefined;
  if (mac === undefined) return undefined;
  // A group address answers for nobody, and all zeroes is no address at all.
  if (((mac[0] ?? 0) & 0x01) !== 0 || mac.every((byte) => byte === 0)) return undefined;
  return [...mac].map((byte) => byte.toString(16).padStart(2, '0')).join(':');
}

/** The address, as the kernel prints it, when it is link-local (fe80::/10). */
function linkLocal(bytes: Uint8Array | undefined): string | undefined {
  if (bytes === undefined || bytes.length !== 16) return undefined;
  if (bytes[0] !== 0xfe || ((bytes[1] ?? 0) & 0xc0) !== 0x80) return undefined;
  return formatIpv6(bytes);
}

/**
 * RFC 5952, which is what `ip neigh` prints: lowercase, no leading zeros, and
 * the longest run of two or more zero groups — the first, on a tie — as `::`.
 * The keep-alive compares these with what the kernel prints, character for
 * character, so any other spelling of the same address would be asked about
 * twice.
 */
export function formatIpv6(bytes: Uint8Array): string {
  const groups = Array.from({ length: 8 }, (_, i) => ((bytes[2 * i] ?? 0) << 8) | (bytes[2 * i + 1] ?? 0));
  let start = -1;
  let length = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i += 1;
      continue;
    }
    let end = i;
    while (end < 8 && groups[end] === 0) end += 1;
    if (end - i > length) {
      start = i;
      length = end - i;
    }
    i = end;
  }
  const hex = groups.map((group) => group.toString(16));
  if (length < 2) return hex.join(':');
  return `${hex.slice(0, start).join(':')}::${hex.slice(start + length).join(':')}`;
}

/** A textual IPv6 address — zone and all, as matter.js stores one — as bytes. */
function parseIpv6(text: string): Uint8Array | undefined {
  const bare = text.split('%')[0]!.toLowerCase();
  // An embedded IPv4 tail is never link-local, and never worth parsing here.
  if (!isIPv6(bare) || bare.includes('.')) return undefined;
  const halves = bare.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right] : left;
  if (groups.length !== 8) return undefined;
  const bytes = new Uint8Array(16);
  groups.forEach((group, i) => {
    const value = Number.parseInt(group, 16);
    bytes[2 * i] = value >> 8;
    bytes[2 * i + 1] = value & 0xff;
  });
  return bytes;
}
