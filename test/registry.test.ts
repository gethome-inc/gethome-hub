import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { DeviceRegistry } from '../src/core/registry.js';
import { HubEventBus } from '../src/core/bus.js';
import { ActivityService } from '../src/core/activity.js';
import type { AdapterBus, ProtocolAdapter } from '../src/adapters/adapter.js';
import type { HubCommand } from '../src/schema/index.js';
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

  it('survives a restart from Postgres alone', async () => {
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
});
