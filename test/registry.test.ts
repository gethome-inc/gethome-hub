import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { DeviceRegistry } from '../src/core/registry.js';
import { HubEventBus } from '../src/core/bus.js';
import { ActivityService } from '../src/core/activity.js';
import type { AdapterBus, ProtocolAdapter } from '../src/adapters/adapter.js';
import type { HubCommand } from '../src/schema/index.js';
import { eq } from 'drizzle-orm';
import { activity, devices, endpoints } from '../src/db/schema.js';
import { openTestDb, resetDb } from './helpers/db.js';

const handle = await openTestDb();
const log = pino({ level: 'silent' });

class FakeAdapter implements ProtocolAdapter {
  readonly id = 'mqtt' as const;
  bus: AdapterBus | null = null;
  executed: Array<{ externalId: string; endpointId: number; command: HubCommand }> = [];
  forgotten: string[] = [];

  async start(bus: AdapterBus): Promise<void> {
    this.bus = bus;
  }
  async stop(): Promise<void> {}
  async execute(externalId: string, endpointId: number, command: HubCommand): Promise<void> {
    this.executed.push({ externalId, endpointId, command });
  }
  async forget(externalId: string): Promise<void> {
    this.forgotten.push(externalId);
  }
}

const lampDescriptor = {
  adapter: 'mqtt' as const,
  externalId: 'lamp-1',
  vendor: 'Acme',
  model: 'Lamp One',
  suggestedName: 'Desk lamp',
  endpoints: [
    {
      endpointId: 1,
      deviceKind: 'light' as const,
      capabilities: ['onOff', 'level'] as ('onOff' | 'level')[],
      primary: 'onOff' as const,
    },
  ],
};

describe.skipIf(!handle)('DeviceRegistry', () => {
  // Skipped suites still have their body collected, so never deref a null
  // handle here; `db` is only read once the suite actually runs.
  const db = handle?.db!;
  let events: HubEventBus;
  let registry: DeviceRegistry;
  let adapter: FakeAdapter;

  beforeEach(async () => {
    await resetDb(db);
    events = new HubEventBus();
    adapter = new FakeAdapter();
    registry = new DeviceRegistry(db, events, new ActivityService(db, events), log);
    registry.registerAdapter(adapter);
    await registry.start();
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('persists announced devices with endpoints and empty state', async () => {
    adapter.bus!.deviceUpserted(lampDescriptor);
    await registry.flush();

    const devices = registry.listDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]!.name).toBe('Desk lamp');
    expect(devices[0]!.endpoints[0]!.capabilities).toEqual(['onOff', 'level']);
    expect(devices[0]!.endpoints[0]!.state.reachable).toBe(true);
  });

  it('merges state patches and fans out events', async () => {
    adapter.bus!.deviceUpserted(lampDescriptor);
    await registry.flush();
    const deviceId = registry.listDevices()[0]!.id;

    const seen = vi.fn();
    events.on('stateChanged', seen);
    adapter.bus!.stateChanged('mqtt', 'lamp-1', 1, { onOff: true });
    adapter.bus!.stateChanged('mqtt', 'lamp-1', 1, { level: { current: 200, min: 1, max: 254 } });
    await registry.flush();

    const state = registry.getDevice(deviceId)!.endpoints[0]!.state;
    expect(state.onOff).toBe(true);
    expect(state.level?.current).toBe(200);
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('survives a restart from the database alone', async () => {
    adapter.bus!.deviceUpserted(lampDescriptor);
    await registry.flush();
    adapter.bus!.stateChanged('mqtt', 'lamp-1', 1, { onOff: true });
    await registry.flush();

    const reloaded = new DeviceRegistry(db, events, new ActivityService(db, events), log);
    reloaded.registerAdapter(new FakeAdapter());
    await reloaded.start();
    const device = reloaded.listDevices()[0]!;
    expect(device.name).toBe('Desk lamp');
    expect(device.endpoints[0]!.state.onOff).toBe(true);
  });

  it('serves state from the cache before it has been persisted, and persists it on stop', async () => {
    adapter.bus!.deviceUpserted(lampDescriptor);
    await registry.flush();

    // A burst, as a power meter or a motion sensor produces. Reads are answered
    // from the cache immediately; the row is deliberately still behind.
    for (let level = 10; level <= 200; level += 10) {
      adapter.bus!.stateChanged('mqtt', 'lamp-1', 1, { level: { current: level, min: 1, max: 254 } });
    }
    await Promise.all([...(registry as unknown as { queue: Map<string, Promise<void>> }).queue.values()]);
    expect(registry.listDevices()[0]!.endpoints[0]!.state.level?.current).toBe(200);

    const beforeFlush = new DeviceRegistry(db, events, new ActivityService(db, events), log);
    await beforeFlush.start();
    expect(beforeFlush.listDevices()[0]!.endpoints[0]!.state.level?.current).toBeUndefined();

    await registry.stop();

    const afterFlush = new DeviceRegistry(db, events, new ActivityService(db, events), log);
    await afterFlush.start();
    expect(afterFlush.listDevices()[0]!.endpoints[0]!.state.level?.current).toBe(200);
  });

  it('keeps the user-chosen name across re-announcements', async () => {
    adapter.bus!.deviceUpserted(lampDescriptor);
    await registry.flush();
    const deviceId = registry.listDevices()[0]!.id;
    await registry.updateDevice(deviceId, { name: 'Reading light' });

    adapter.bus!.deviceUpserted({ ...lampDescriptor, suggestedName: 'Desk lamp v2' });
    await registry.flush();
    expect(registry.getDevice(deviceId)!.name).toBe('Reading light');
  });

  it('reconciles endpoint capabilities on re-announcement (AI remap path)', async () => {
    adapter.bus!.deviceUpserted({ ...lampDescriptor, needsReview: true });
    await registry.flush();
    const deviceId = registry.listDevices()[0]!.id;
    expect(registry.getDevice(deviceId)!.needsReview).toBe(true);

    adapter.bus!.deviceUpserted({
      ...lampDescriptor,
      needsReview: false,
      endpoints: [
        {
          endpointId: 1,
          deviceKind: 'light',
          capabilities: ['onOff', 'level', 'colorTemperature'],
          primary: 'onOff',
        },
      ],
    });
    await registry.flush();
    const device = registry.getDevice(deviceId)!;
    expect(device.needsReview).toBe(false);
    expect(device.endpoints[0]!.capabilities).toContain('colorTemperature');
  });

  it('routes commands to the owning adapter', async () => {
    adapter.bus!.deviceUpserted(lampDescriptor);
    await registry.flush();
    const deviceId = registry.listDevices()[0]!.id;

    await registry.execute(deviceId, 1, { type: 'power', on: true });
    expect(adapter.executed).toEqual([
      { externalId: 'lamp-1', endpointId: 1, command: { type: 'power', on: true } },
    ]);
  });

  it('marks devices offline and back online', async () => {
    adapter.bus!.deviceUpserted(lampDescriptor);
    await registry.flush();
    const deviceId = registry.listDevices()[0]!.id;

    adapter.bus!.reachabilityChanged('mqtt', 'lamp-1', false);
    await registry.flush();
    expect(registry.getDevice(deviceId)!.online).toBe(false);
    expect(registry.getDevice(deviceId)!.endpoints[0]!.state.reachable).toBe(false);
  });

  it('writes the endpoints\u2019 own reachability to the disk, not only to the cache', async () => {
    adapter.bus!.deviceUpserted(lampDescriptor);
    await registry.flush();

    adapter.bus!.reachabilityChanged('mqtt', 'lamp-1', false);
    await registry.stop();

    // `reachable` lives in two places — the device row and every endpoint's
    // state — and the second used to be mutated in memory and never marked
    // dirty, so it reached the card only if some later state report happened
    // to flush. A reload is the whole test.
    const reloaded = new DeviceRegistry(db, events, new ActivityService(db, events), log);
    await reloaded.start();
    expect(reloaded.listDevices()[0]!.online).toBe(false);
    expect(reloaded.listDevices()[0]!.endpoints[0]!.state.reachable).toBe(false);
  });

  it('repairs an endpoint left behind by the row it agrees with', async () => {
    adapter.bus!.deviceUpserted(lampDescriptor);
    await registry.flush();
    const deviceId = registry.listDevices()[0]!.id;

    // The state a hub is actually found in: the row says the device is
    // reachable, one endpoint still says it is not. The two are persisted on
    // different schedules and loaded back from two tables, so a restart can
    // land here — and the apps disagree about the same device, because Studio
    // draws `online` while the iOS app draws `online && state.reachable`.
    await db.update(devices).set({ online: true }).where(eq(devices.id, deviceId));
    await db
      .update(endpoints)
      .set({ state: { ...registry.getDevice(deviceId)!.endpoints[0]!.state, reachable: false } })
      .where(eq(endpoints.deviceId, deviceId));
    await registry.stop();

    const reloaded = new DeviceRegistry(db, events, new ActivityService(db, events), log);
    reloaded.registerAdapter(adapter);
    await reloaded.start();
    expect(reloaded.getDevice(deviceId)!.online).toBe(true);
    expect(reloaded.getDevice(deviceId)!.endpoints[0]!.state.reachable).toBe(false);

    // The radio coming up says "reachable" about a device whose row already
    // said so. Guarding on the row alone returned here and left the endpoint
    // stuck at false for ever, because nothing else writes that field.
    adapter.bus!.radioReachabilityChanged('mqtt', true);
    await reloaded.flush();
    expect(reloaded.getDevice(deviceId)!.endpoints[0]!.state.reachable).toBe(true);

    // And a repair is not a transition: nothing about the device changed, so
    // the feed must not claim it came back.
    const rows = await db.select().from(activity);
    expect(rows.some((row) => row.kind === 'device.online')).toBe(false);
  });

  it('takes every device on a radio offline when the radio goes', async () => {
    adapter.bus!.deviceUpserted(lampDescriptor);
    adapter.bus!.deviceUpserted({ ...lampDescriptor, externalId: 'lamp-2', suggestedName: 'Hall lamp' });
    await registry.flush();

    adapter.bus!.radioReachabilityChanged('mqtt', false);
    await registry.flush();
    expect(registry.listDevices().map((device) => device.online)).toEqual([false, false]);
    expect(registry.listDevices().every((device) => device.endpoints[0]!.state.reachable === false)).toBe(true);

    adapter.bus!.radioReachabilityChanged('mqtt', true);
    await registry.flush();
    expect(registry.listDevices().map((device) => device.online)).toEqual([true, true]);
  });

  /**
   * Announced before the devices it takes with it. The per-device frames say
   * which went; only this says why, and an app told in the other order draws a
   * home half offline with nothing to explain it.
   */
  it('announces a radio change before the devices it takes with it', async () => {
    adapter.bus!.deviceUpserted(lampDescriptor);
    await registry.flush();

    const order: string[] = [];
    events.on('radioChanged', (adapterId, reachable) => {
      order.push(`radio:${adapterId}:${reachable}`);
    });
    events.on('deviceUpserted', () => order.push('device'));

    adapter.bus!.radioReachabilityChanged('mqtt', false);
    await registry.flush();

    expect(order[0]).toBe('radio:mqtt:false');
    expect(order).toContain('device');
  });

  it('leaves other adapters alone when one radio goes', async () => {
    adapter.bus!.deviceUpserted(lampDescriptor);
    await registry.flush();

    adapter.bus!.radioReachabilityChanged('zigbee', false);
    await registry.flush();
    expect(registry.listDevices()[0]!.online).toBe(true);
  });

  /**
   * The case a one-radio board actually produces: the hub restarts with the
   * Matter adapter switched off, so its devices come back out of SQLite with
   * the `online` they had when it last ran and nothing is left to correct
   * them. They must load offline — the app is about to tell somebody that
   * switching radios is why half their home stopped answering.
   */
  it('starts devices of an unregistered adapter offline', async () => {
    adapter.bus!.deviceUpserted(lampDescriptor);
    await registry.flush();
    const deviceId = registry.listDevices()[0]!.id;

    const restarted = new DeviceRegistry(db, events, new ActivityService(db, events), log);
    await restarted.start();
    await restarted.flush();

    expect(restarted.getDevice(deviceId)!.online).toBe(false);
    expect(restarted.getDevice(deviceId)!.endpoints[0]!.state.reachable).toBe(false);
  });

  it('starts devices of an adapter that failed to start offline', async () => {
    adapter.bus!.deviceUpserted(lampDescriptor);
    await registry.flush();
    const deviceId = registry.listDevices()[0]!.id;

    const broken: ProtocolAdapter = {
      id: 'mqtt',
      start: async () => {
        throw new Error('no broker');
      },
      stop: async () => {},
      execute: async () => {},
    };
    const restarted = new DeviceRegistry(db, events, new ActivityService(db, events), log);
    restarted.registerAdapter(broken);
    await restarted.start();
    await restarted.flush();

    expect(restarted.getDevice(deviceId)!.online).toBe(false);
  });

  it('records a join once ever, not again when the hub restarts', async () => {
    adapter.bus!.deviceUpserted(lampDescriptor);
    await registry.flush();

    // A restart: fresh registry, fresh adapter, same database. Every adapter
    // re-announces what it can see — its own memory of the network is gone —
    // and the device must not "join the home" a second time. This is why the
    // join row belongs to the registry, which is keyed on the database, and
    // not to an adapter, which is keyed on a map it rebuilds at every boot.
    const second = new DeviceRegistry(db, events, new ActivityService(db, events), log);
    const restarted = new FakeAdapter();
    second.registerAdapter(restarted);
    await second.start();
    restarted.bus!.deviceUpserted(lampDescriptor);
    await second.flush();

    const joins = (await db.select().from(activity)).filter((row) => row.kind === 'device.added');
    expect(joins).toHaveLength(1);
  });

  it('logs reachability transitions, but not while the hub is still catching up', async () => {
    const kinds = async () => (await db.select().from(activity)).map((row) => row.kind);

    adapter.bus!.deviceUpserted(lampDescriptor);
    await registry.flush();

    // Inside the start-up quiet window: the cache is corrected, the log is not.
    // A reconnect sweep is the hub catching up, not something that happened.
    adapter.bus!.reachabilityChanged('mqtt', 'lamp-1', false);
    await registry.flush();
    expect(registry.listDevices()[0]!.online).toBe(false);
    expect(await kinds()).not.toContain('device.offline');

    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5 * 60_000);
    try {
      adapter.bus!.reachabilityChanged('mqtt', 'lamp-1', true);
      await registry.flush();
    } finally {
      clock.mockRestore();
    }
    expect(await kinds()).toContain('device.online');

    // Only the transition: a repeat of what the cache already holds is silent.
    adapter.bus!.reachabilityChanged('mqtt', 'lamp-1', true);
    await registry.flush();
    expect((await kinds()).filter((kind) => kind === 'device.online')).toHaveLength(1);
  });

  it('forgets devices at the protocol level on removal', async () => {
    adapter.bus!.deviceUpserted(lampDescriptor);
    await registry.flush();
    const deviceId = registry.listDevices()[0]!.id;

    const removed = vi.fn();
    events.on('deviceRemoved', removed);
    await registry.removeDevice(deviceId);
    await registry.flush();

    expect(adapter.forgotten).toEqual(['lamp-1']);
    expect(registry.listDevices()).toHaveLength(0);
    expect(removed).toHaveBeenCalledWith(deviceId);
  });

  describe('a write that reached the protocol and not the device', () => {
    /**
     * `execute()` resolving has never meant the device did anything — the
     * Zigbee adapter publishes to MQTT and MQTT resolves when the broker takes
     * the message. This is the only route by which "it didn't land" reaches a
     * client at all.
     */
    it('names the device by its own id, not the adapter’s', async () => {
      adapter.bus!.deviceUpserted(lampDescriptor);
      await registry.flush();
      const deviceId = registry.listDevices()[0]!.id;

      const failed = vi.fn();
      events.on('commandFailed', failed);
      adapter.bus!.commandFailed('mqtt', 'lamp-1', {
        property: 'detection_interval',
        kind: 'unreachable',
        detail: 'Device did not respond',
      });

      expect(failed).toHaveBeenCalledWith({
        deviceId,
        property: 'detection_interval',
        kind: 'unreachable',
        detail: 'Device did not respond',
      });
    });

    it('drops a superseded write, which is not a failure', async () => {
      // A newer write to the same property replaced this one in the queue, so
      // the value is still on its way. The Zigbee adapter drops these before
      // calling; the registry repeats the check because this is the seam a
      // second adapter arrives at.
      adapter.bus!.deviceUpserted(lampDescriptor);
      await registry.flush();

      const failed = vi.fn();
      events.on('commandFailed', failed);
      adapter.bus!.commandFailed('mqtt', 'lamp-1', {
        property: 'detection_interval',
        kind: 'superseded',
        detail: 'Request superseded',
      });

      expect(failed).not.toHaveBeenCalled();
    });

    it('says nothing about a device it does not track', () => {
      // The coordinator, or something mid-interview. There is no id to name.
      const failed = vi.fn();
      events.on('commandFailed', failed);
      adapter.bus!.commandFailed('mqtt', 'nobody', {
        property: 'state',
        kind: 'refused',
        detail: 'nope',
      });

      expect(failed).not.toHaveBeenCalled();
    });

    it('writes nothing to the activity log', async () => {
      // The log is read a week later; a write that failed at 17:11 is not
      // history, it is a thing on screen right now. `device.command` already
      // recorded the ask.
      const rows = async () => db.select().from(activity);

      adapter.bus!.deviceUpserted(lampDescriptor);
      await registry.flush();
      const before = (await rows()).length;

      adapter.bus!.commandFailed('mqtt', 'lamp-1', {
        property: 'detection_interval',
        kind: 'refused',
        detail: 'nope',
      });
      await registry.flush();

      expect(await rows()).toHaveLength(before);
    });
  });
});
