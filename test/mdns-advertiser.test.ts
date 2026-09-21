import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MdnsAdvertiser } from '../src/mdns/advertiser.js';
import type { Logger } from '../src/logging.js';

/**
 * What the hub tells the network about itself.
 *
 * The avahi path is the one every Raspberry Pi takes — `chooseBackend` picks
 * it whenever `/etc/avahi/services` exists — and until now nothing here was
 * covered at all, which is how the advertisement came to name an address
 * family the API has never listened on.
 *
 * The ciao path is deliberately not exercised: it binds UDP 5353 and claims a
 * name on whatever network the machine running the suite is attached to, which
 * is not something a test may do. `disabledIpv6` is asserted where it can be —
 * in review, against ciao's own documented meaning — rather than by starting a
 * responder in CI.
 */

const dirs: string[] = [];

function servicesDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gethome-mdns-'));
  dirs.push(dir);
  return dir;
}

const log = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;

function advertiser(dir: string, hubName = 'Summer House'): MdnsAdvertiser {
  return new MdnsAdvertiser({
    hubId: 'hub-1234',
    hubName,
    port: 8420,
    version: '1.4.0',
    backend: 'avahi',
    servicesDir: dir,
    log,
  });
}

function published(dir: string): string {
  return readFileSync(path.join(dir, 'gethome-hub.service'), 'utf8');
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('MdnsAdvertiser — the avahi service file', () => {
  it('announces over IPv4 only, because that is all the API binds', async () => {
    const dir = servicesDir();
    await advertiser(dir).start(false);
    // The attribute, not merely the string: `protocol` anywhere else in the
    // file would pass a looser match while the service stayed on `any`.
    expect(published(dir)).toContain('<service protocol="ipv4">');
  });

  it('publishes the port and the identity the apps read before any HTTP', async () => {
    const dir = servicesDir();
    await advertiser(dir).start(false);
    const file = published(dir);
    expect(file).toContain('<type>_gethome._tcp</type>');
    expect(file).toContain('<port>8420</port>');
    expect(file).toContain('<txt-record>id=hub-1234</txt-record>');
    expect(file).toContain('<txt-record>ver=1.4.0</txt-record>');
    expect(file).toContain('<txt-record>api=1</txt-record>');
    expect(file).toContain('<txt-record>claimed=0</txt-record>');
  });

  it('keeps the family when the claim state changes', async () => {
    const dir = servicesDir();
    const mdns = advertiser(dir);
    await mdns.start(false);
    mdns.updateClaimed(true);
    const file = published(dir);
    expect(file).toContain('<txt-record>claimed=1</txt-record>');
    expect(file).toContain('<service protocol="ipv4">');
  });

  it('keeps the family when the hub is renamed', async () => {
    // Three call sites rewrite this file whole, so the rule has to survive a
    // rewrite rather than only a first boot — a rename is the one an owner
    // actually performs.
    const dir = servicesDir();
    const mdns = advertiser(dir);
    await mdns.start(true);
    await mdns.updateName('The Lighthouse');
    const file = published(dir);
    expect(file).toContain('<name replace-wildcards="yes">The Lighthouse</name>');
    expect(file).toContain('<service protocol="ipv4">');
  });

  it('escapes a name that would otherwise break the XML', async () => {
    const dir = servicesDir();
    await advertiser(dir, 'Tom & Jerry\'s <house>').start(false);
    const file = published(dir);
    expect(file).toContain('Tom &amp; Jerry\'s &lt;house&gt;');
    expect(file).not.toContain('<house>');
  });
});
