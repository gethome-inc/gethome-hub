import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  formatIpv6,
  formatNeighbours,
  MATTER_NEIGHBOURS_FILE,
  MatterNeighbourFile,
  neighboursOf,
  type MatterNeighbour,
} from '../src/adapters/matter/neighbours.js';

/**
 * **Where the hub's Matter accessories are, written down for the keep-alive.**
 *
 * Found on a hub whose plug had been switched off for days: its own uptime put
 * it back on the network at 09:58, and the hub — retrying at the right address
 * every two minutes — reached it at 10:07, because every retry died in IPv6
 * neighbour discovery, which is multicast, and the router passed the hub's
 * multicast to that plug 7 times in 30 while unicast went 30 in 30. The
 * keep-alive asks after a neighbour by unicast, but only one the kernel has
 * seen, for a day; this is the list the hub can keep for longer.
 */

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const hex = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, 'hex'));

/**
 * The plug's `NetworkInterfaces` in the shape matter.js had cached it on that
 * hub, with its MAC — and the link-local address made from it — swapped for a
 * locally administered example.
 */
const PLUG = [
  {
    name: 'WIFI_STA_DEF',
    isOperational: true,
    offPremiseServicesReachableIPv4: null,
    offPremiseServicesReachableIPv6: null,
    hardwareAddress: hex('0a1b2c3d4e5f'),
    iPv4Addresses: [hex('c0a800da')],
    iPv6Addresses: [hex('fe80000000000000081b2cfffe3d4e5f')],
    type: 1,
  },
];

describe('where a Matter accessory is on the link', () => {
  it('reads the address and link address the accessory reports about itself', () => {
    expect(neighboursOf(PLUG)).toEqual([{ address: 'fe80::81b:2cff:fe3d:4e5f', mac: '0a:1b:2c:3d:4e:5f' }]);
  });

  /**
   * **Link-local only.** An IPv4 lease moves to another device while this one
   * is switched off, and seeding it with this one's MAC would send the new
   * owner's traffic here; a global or unique-local address is reached through
   * a router rather than asked for on the link.
   */
  it('never lists an IPv4, global or unique-local address', () => {
    const [plug] = PLUG;
    const listed = neighboursOf([
      {
        ...plug,
        iPv6Addresses: [
          hex('20010db8000000000000000000000001'),
          hex('fd000000000000000000000000000001'),
          hex('fe80000000000000081b2cfffe3d4e5f'),
        ],
      },
    ]);
    expect(listed.map((neighbour) => neighbour.address)).toEqual(['fe80::81b:2cff:fe3d:4e5f']);
  });

  /** A Thread radio's address is an 802.15.4 one, reached through a border router, never on this link. */
  it('skips a Thread interface', () => {
    expect(
      neighboursOf([
        {
          name: 'thread',
          hardwareAddress: hex('36b1a5b0c2d4e6f8'),
          iPv6Addresses: [hex('fe8000000000000034b1a5b0c2d4e6f8')],
          type: 4,
        },
      ]),
    ).toEqual([]);
  });

  /** The spec lets a 48-bit address arrive as eight bytes with the first two zero. */
  it('takes a MAC sent in eight bytes, and nothing else that is not one', () => {
    const iface = (hardwareAddress: Uint8Array): unknown => ({
      hardwareAddress,
      iPv6Addresses: [hex('fe800000000000000000000000000005')],
      type: 1,
    });
    expect(neighboursOf([iface(hex('0000020000000005'))])).toEqual([{ address: 'fe80::5', mac: '02:00:00:00:00:05' }]);
    // An EUI-64 is not a MAC, a group address answers for nobody, and neither does nothing.
    expect(neighboursOf([iface(hex('0200000000000005'))])).toEqual([]);
    expect(neighboursOf([iface(hex('010000000005'))])).toEqual([]);
    expect(neighboursOf([iface(hex('000000000000'))])).toEqual([]);
    expect(neighboursOf([iface(hex('0200000005'))])).toEqual([]);
  });

  /**
   * An accessory that leaves its own list short is still reached where
   * matter.js will send — against its link address when it has only one, and
   * not at all when it has two and there is no telling which.
   */
  it('adds the address matter.js reaches it at, when there is one link address to pair it with', () => {
    const [plug] = PLUG;
    const short = [{ ...plug, iPv6Addresses: [] }];
    const known = ['fe80::81b:2cff:fe3d:4e5f%wlan0', '192.168.0.218', '2001:db8::1'];
    expect(neighboursOf(short, known)).toEqual([{ address: 'fe80::81b:2cff:fe3d:4e5f', mac: '0a:1b:2c:3d:4e:5f' }]);
    const twoRadios = [...short, { ...plug, hardwareAddress: hex('0a1b2c3d4e60'), iPv6Addresses: [], type: 2 }];
    expect(neighboursOf(twoRadios, known)).toEqual([]);
    // Spelled any way at all, it is one address.
    expect(neighboursOf(PLUG, ['FE80:0:0:0:081B:2CFF:FE3D:4E5F%wlan0'])).toHaveLength(1);
  });

  /** It comes out of a cache: a malformed entry costs that entry, never the hub. */
  it('survives anything a cache could hand it', () => {
    for (const junk of [undefined, null, 'wlan0', 5, {}, [null, 1, 'x', {}, { hardwareAddress: 'nope' }]]) {
      expect(neighboursOf(junk, ['not an address', ''])).toEqual([]);
    }
    expect(neighboursOf([{ hardwareAddress: hex('0a1b2c3d4e5f'), iPv6Addresses: [hex('fe80'), 'fe80::1', null] }])).toEqual(
      [],
    );
  });

  it('takes an octet string in any of the shapes a cache may give one', () => {
    const buffer = hex('0a1b2c3d4e5f').buffer.slice(0);
    const view = new DataView(hex('00fe80000000000000081b2cfffe3d4e5f').buffer, 1, 16);
    expect(neighboursOf([{ hardwareAddress: buffer, iPv6Addresses: [view], type: 1 }])).toEqual([
      { address: 'fe80::81b:2cff:fe3d:4e5f', mac: '0a:1b:2c:3d:4e:5f' },
    ]);
  });
});

/**
 * **Spelled exactly as the kernel prints it**, because the keep-alive compares
 * the two character for character: any other spelling of the same address is
 * an accessory asked about twice.
 */
describe('writing an address the way ip prints it', () => {
  const groups = (...values: number[]): Uint8Array =>
    Uint8Array.from(values.flatMap((value) => [value >> 8, value & 0xff]));

  it('follows RFC 5952', () => {
    expect(formatIpv6(groups(0xfe80, 0, 0, 0, 0x081b, 0x2cff, 0xfe3d, 0x4e5f))).toBe('fe80::81b:2cff:fe3d:4e5f');
    expect(formatIpv6(groups(0xfe80, 0, 0, 0, 0, 0, 0, 1))).toBe('fe80::1');
    expect(formatIpv6(groups(0xfe80, 0, 0, 0, 0, 0, 0, 0))).toBe('fe80::');
    // The first of two equal runs, never a lone zero, and the longer run over an earlier one.
    expect(formatIpv6(groups(0xfe80, 0, 0, 1, 0, 0, 1, 1))).toBe('fe80::1:0:0:1:1');
    expect(formatIpv6(groups(0xfe80, 0, 1, 1, 1, 1, 1, 1))).toBe('fe80:0:1:1:1:1:1:1');
    expect(formatIpv6(groups(0xfe80, 0, 1, 0, 0, 0, 1, 1))).toBe('fe80:0:1::1:1');
    expect(formatIpv6(groups(0xfe80, 0, 0, 0, 0x000a, 0x00b0, 0x0c00, 0xd000))).toBe('fe80::a:b0:c00:d000');
  });

  /** The URL serializer compresses by the same rule, so it is an oracle for every shape of zero run. */
  it('agrees with the platform for every pattern of zero groups', () => {
    for (let mask = 0; mask < 1 << 7; mask += 1) {
      const values = [0xfe80, ...Array.from({ length: 7 }, (_, i) => ((mask >> i) & 1 ? 0 : 0x1a2b + i))];
      const bytes = groups(...values);
      const full = values.map((value) => value.toString(16)).join(':');
      expect(formatIpv6(bytes)).toBe(new URL(`http://[${full}]/`).hostname.slice(1, -1));
    }
  });
});

describe('the file the keep-alive reads', () => {
  const plug: MatterNeighbour = { address: 'fe80::81b:2cff:fe3d:4e5f', mac: '0a:1b:2c:3d:4e:5f' };
  const lamp: MatterNeighbour = { address: 'fe80::5', mac: '02:00:00:00:00:05' };

  it('is one line per address, the same whatever order the nodes arrived in', () => {
    const one = formatNeighbours(new Map([['1', [plug]], ['2', [lamp]]]));
    const other = formatNeighbours(new Map([['2', [lamp]], ['1', [plug, plug]]]));
    expect(one).toBe(other);
    const lines = one.split('\n');
    expect(lines.filter((line) => line !== '' && !line.startsWith('#'))).toEqual([
      'fe80::5 02:00:00:00:00:05',
      'fe80::81b:2cff:fe3d:4e5f 0a:1b:2c:3d:4e:5f',
    ]);
    expect(one.endsWith('\n')).toBe(true);
  });

  function place(): { file: string; log: { warn: Mock<(details: object, message: string) => void> } } {
    const dir = mkdtempSync(path.join(tmpdir(), 'gethome-neighbours-'));
    dirs.push(dir);
    return { file: path.join(dir, MATTER_NEIGHBOURS_FILE), log: { warn: vi.fn() } };
  }

  const listed = (file: string): string[] =>
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'));

  /**
   * **Nothing until every commissioned node has been asked**, so the file is
   * never rewritten on the way up with fewer accessories than the hub owns.
   */
  it('writes nothing until it is opened, then everything it was told', async () => {
    const { file, log } = place();
    const neighbours = new MatterNeighbourFile(file, log, 0);
    neighbours.set('1', [plug]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(file)).toBe(false);
    neighbours.set('2', [lamp]);
    await neighbours.open();
    expect(listed(file)).toEqual(['fe80::5 02:00:00:00:00:05', 'fe80::81b:2cff:fe3d:4e5f 0a:1b:2c:3d:4e:5f']);
  });

  it('empties a list left over from accessories the hub no longer owns', async () => {
    const { file, log } = place();
    writeFileSync(file, 'fe80::9 02:00:00:00:00:09\n');
    await new MatterNeighbourFile(file, log).open();
    expect(listed(file)).toEqual([]);
  });

  it('follows every change once open, and forgets a node that is removed', async () => {
    const { file, log } = place();
    const neighbours = new MatterNeighbourFile(file, log, 5);
    neighbours.set('1', [plug]);
    await neighbours.open();
    neighbours.set('2', [lamp]);
    await vi.waitFor(() => expect(listed(file)).toHaveLength(2), { timeout: 2000 });
    neighbours.delete('1');
    await vi.waitFor(() => expect(listed(file)).toEqual(['fe80::5 02:00:00:00:00:05']), { timeout: 2000 });
  });

  /** A report that repeats an accessory's addresses is most reports, and costs no write. */
  it('does not write the same contents twice', async () => {
    const { file, log } = place();
    const neighbours = new MatterNeighbourFile(file, log, 60_000);
    neighbours.set('1', [plug]);
    await neighbours.open();
    unlinkSync(file);
    neighbours.set('1', [{ ...plug }]);
    await neighbours.flush();
    expect(existsSync(file)).toBe(false);
  });

  it('writes what is outstanding when the hub stops', async () => {
    const { file, log } = place();
    const neighbours = new MatterNeighbourFile(file, log, 60_000);
    await neighbours.open();
    neighbours.set('1', [plug]);
    await neighbours.close();
    expect(listed(file)).toEqual(['fe80::81b:2cff:fe3d:4e5f 0a:1b:2c:3d:4e:5f']);
  });

  /** It helps the hub reach accessories; nothing about reaching them may stop for it. */
  it('logs a write it cannot make, and never throws', async () => {
    const { file, log } = place();
    const neighbours = new MatterNeighbourFile(path.join(file, 'no-such-directory', MATTER_NEIGHBOURS_FILE), log);
    neighbours.set('1', [plug]);
    await expect(neighbours.open()).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
