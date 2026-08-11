import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { HubEventBus } from '../src/core/bus.js';
import { ActivityService } from '../src/core/activity.js';
import { DeviceRegistry } from '../src/core/registry.js';
import { SettingsService } from '../src/core/settings.js';
import { MappingLibrary, MAPPING_ENVELOPE_VERSION } from '../src/ai/library.js';
import { openTestDb, resetDb } from './helpers/db.js';

const handle = await openTestDb();
const log = pino({ level: 'silent' });

const HASH = 'a'.repeat(64);

const goodDescriptor = {
  version: 1,
  endpoints: [
    {
      endpointId: 1,
      deviceKind: 'light',
      capabilities: ['onOff'],
      primary: 'onOff',
      stateRules: [
        { property: 'state', to: 'onOff', transform: { kind: 'boolMap', whenTrue: 'ON', whenFalse: 'OFF' } },
      ],
      commandRules: [],
      customFields: [],
    },
  ],
};

const envelope = {
  gethomeDeviceMapping: MAPPING_ENVELOPE_VERSION,
  adapter: 'zigbee',
  vendor: 'Acme',
  model: 'AC-LAMP-1',
  exposesHash: HASH,
  descriptor: goodDescriptor,
};

describe.skipIf(!handle)('the device-mapping library', () => {
  const db = handle?.db!;
  let library: MappingLibrary;

  beforeEach(async () => {
    await resetDb(db);
    const events = new HubEventBus();
    const registry = new DeviceRegistry(db, events, new ActivityService(db, events), log);
    library = new MappingLibrary({
      db,
      settings: new SettingsService(db, Buffer.alloc(32).toString('base64')),
      registry,
      log,
    });
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('stores an uploaded envelope and lists it', async () => {
    const outcome = await library.import(HASH, envelope);
    expect(outcome).toMatchObject({ ok: true, exposesHash: HASH, hashMismatch: false });

    const entries = await library.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      exposesHash: HASH,
      vendor: 'Acme',
      model: 'AC-LAMP-1',
      status: 'generated',
      source: 'imported',
      endpoints: 1,
    });
  });

  it('accepts a bare descriptor too, since that is also a thing people have in a file', async () => {
    const outcome = await library.import(HASH, goodDescriptor);
    expect(outcome.ok).toBe(true);
  });

  it('hands back a downloadable envelope naming the device it is for', async () => {
    await library.import(HASH, envelope);
    const download = await library.get(HASH);

    expect(download).toMatchObject({
      gethomeDeviceMapping: MAPPING_ENVELOPE_VERSION,
      vendor: 'Acme',
      model: 'AC-LAMP-1',
      exposesHash: HASH,
    });
    // A bare descriptor would not say which device it belongs to.
    expect(download?.descriptor).toEqual(goodDescriptor);
  });

  it('has nothing to hand back for a model it has never seen', async () => {
    expect(await library.get('b'.repeat(64))).toBeNull();
  });

  it('rejects a broken document, and says exactly what is wrong', async () => {
    const outcome = await library.import(HASH, { version: 1, endpoints: [{ endpointId: 1 }] });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.problems.length).toBeGreaterThan(0);
    expect(outcome.problems.join('\n')).toMatch(/deviceKind|capabilities|primary/);
  });

  it('keeps a rejected document, because that is what a repair works from', async () => {
    await library.import(HASH, { version: 1, endpoints: [{ endpointId: 1 }] });

    const entries = await library.list();
    expect(entries[0]).toMatchObject({ status: 'rejected', source: 'imported' });
    expect(entries[0]!.problems?.length).toBeGreaterThan(0);
  });

  it('refuses a descriptor that passes the schema but not the sanity checks', async () => {
    // `primary` is not among the declared capabilities — structurally fine,
    // semantically nonsense, and exactly what strict tool schemas cannot catch.
    const outcome = await library.import(HASH, {
      version: 1,
      endpoints: [
        {
          endpointId: 1,
          deviceKind: 'light',
          capabilities: ['onOff'],
          primary: 'level',
          stateRules: [{ property: 'state', to: 'onOff', transform: { kind: 'identity' } }],
          commandRules: [],
          customFields: [],
        },
      ],
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.problems.join('\n')).toMatch(/primary/i);
  });

  it('flags an envelope written for a neighbouring model rather than refusing it', async () => {
    // A mapping from a device one firmware revision away is the case the whole
    // import path exists for; the app says so, the hub does not block it.
    const outcome = await library.import(HASH, { ...envelope, exposesHash: 'c'.repeat(64) });

    expect(outcome).toMatchObject({ ok: true, hashMismatch: true });
  });

  it('forgets an entry on request', async () => {
    await library.import(HASH, envelope);
    expect(await library.remove(HASH)).toBe(true);
    expect(await library.list()).toHaveLength(0);
  });

  it('reports nothing to forget for a model it does not hold', async () => {
    expect(await library.remove(HASH)).toBe(false);
  });

  it('replaces an entry on a second upload instead of adding a duplicate', async () => {
    await library.import(HASH, { version: 1, endpoints: [{ endpointId: 1 }] });
    await library.import(HASH, envelope);

    const entries = await library.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: 'generated' });
    expect(entries[0]!.problems).toBeNull();
  });

  it('has nothing to repair when the stored mapping is already accepted', async () => {
    await library.import(HASH, envelope);
    const outcome = await library.repair(HASH);

    expect(outcome).toMatchObject({ ok: false, reason: 'nothing_to_repair' });
  });

  it('cannot repair a mapping with no device of that model to check it against', async () => {
    await library.import(HASH, { version: 1, endpoints: [{ endpointId: 1 }] });
    const outcome = await library.repair(HASH);

    expect(outcome).toMatchObject({ ok: false, reason: 'no_device' });
  });
});
