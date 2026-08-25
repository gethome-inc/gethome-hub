import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import mqtt from 'mqtt';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { HubEventBus } from '../../src/core/bus.js';
import { ActivityService } from '../../src/core/activity.js';
import { PairingService } from '../../src/core/pairing.js';
import { SettingsService } from '../../src/core/settings.js';
import { DeviceRegistry } from '../../src/core/registry.js';
import { PermitJoinService } from '../../src/core/permit-join.js';
import { ZigbeeAdapter } from '../../src/adapters/zigbee/adapter.js';
import { MqttAdapter } from '../../src/adapters/mqtt/adapter.js';
import { bootedHome, loadedFavorites, openTestDb, resetDb, loadedAccess } from '../helpers/db.js';

/**
 * End-to-end proof over a real MQTT broker: a fake Zigbee2MQTT bridge and a
 * fake GetHome-convention device on one side, the full hub core + API on the
 * other. Gated on HUB_TEST_MQTT=1 (needs mosquitto on 127.0.0.1:1883 and
 * a local mosquitto).
 */
const enabled = process.env.HUB_TEST_MQTT === '1';
const MQTT_URL = process.env.HUB_TEST_MQTT_URL ?? 'mqtt://127.0.0.1:1883';

const handle = enabled ? await openTestDb() : null;
const log = pino({ level: 'silent' });

const fixtures = JSON.parse(
  readFileSync(path.join(import.meta.dirname, '../fixtures/z2m/devices.json'), 'utf8'),
) as unknown[];

const waitFor = async (predicate: () => boolean, timeoutMs = 8000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe.skipIf(!enabled || !handle)('MQTT round-trip (fake Z2M + convention device)', () => {
  // Skipped suites still have their body collected, so never deref a null
  // handle here; `db` is only read once the suite actually runs.
  const db = handle?.db!;
  let app: FastifyInstance;
  let registry: DeviceRegistry;
  let fake: mqtt.MqttClient;
  let token: string;
  const observed: Array<{ topic: string; payload: string }> = [];

  const auth = () => ({ authorization: `Bearer ${token}` });
  const devices = async () =>
    (await app.inject({ method: 'GET', url: '/api/v1/devices', headers: auth() })).json() as Array<{
      id: string;
      name: string;
      adapter: string;
      endpoints: Array<{ endpointId: number; capabilities: string[]; state: Record<string, unknown> }>;
    }>;

  beforeAll(async () => {
    await resetDb(db);

    // The "device side": a fake Z2M bridge + a fake convention device.
    fake = await mqtt.connectAsync(MQTT_URL);
    await fake.subscribeAsync(['zigbee2mqtt/+/set', 'gethome/device/+/set']);
    fake.on('message', (topic, payload) => observed.push({ topic, payload: payload.toString() }));
    await fake.publishAsync('zigbee2mqtt/bridge/devices', JSON.stringify(fixtures), { retain: true });
    await fake.publishAsync(
      'gethome/discovery/pool-pump/config',
      JSON.stringify({
        name: 'Pool pump',
        vendor: 'Acme',
        endpoints: [
          { endpointId: 1, deviceKind: 'outlet', capabilities: ['onOff', 'electricalPower'], primary: 'onOff' },
        ],
      }),
      { retain: true },
    );

    // The hub side.
    const dataDir = mkdtempSync(path.join(tmpdir(), 'gethome-e2e-'));
    const events = new HubEventBus();
    const activity = new ActivityService(db, events);
    const access = await loadedAccess(db, events);
    const pairing = new PairingService(db, dataDir, log, access);
    await pairing.boot();
    registry = new DeviceRegistry(db, events, activity, log);
    const zigbee = new ZigbeeAdapter({ mqttUrl: MQTT_URL, baseTopic: 'zigbee2mqtt', log });
    registry.registerAdapter(zigbee);
    registry.registerAdapter(new MqttAdapter({ mqttUrl: MQTT_URL, log }));
    await registry.start();

    app = await buildServer({
      db,
      log,
      events,
      registry,
      favorites: await loadedFavorites(db, events),
      pairing,
      activity,
      settings: new SettingsService(db, Buffer.alloc(32).toString('base64')),
      hubId: 'hub-e2e',
      home: await bootedHome(db, 'E2E Hub'),
      version: 'e2e',
      zigbee,
      permitJoin: new PermitJoinService(zigbee, log, () => {}),
    });
    await app.ready();

    const code = readFileSync(path.join(dataDir, 'pairing-code'), 'utf8').trim();
    const claim = await app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      payload: { code, memberName: 'E2E' },
    });
    token = (claim.json() as { token: string }).token;
  }, 30_000);

  afterAll(async () => {
    await fake?.publishAsync('zigbee2mqtt/bridge/devices', '', { retain: true }).catch(() => {});
    await fake?.publishAsync('gethome/discovery/pool-pump/config', '', { retain: true }).catch(() => {});
    await fake?.endAsync().catch(() => {});
    await app?.close();
    await registry?.stop();
    await handle?.close();
  });

  it('discovers the Zigbee fleet and the MQTT convention device over the broker', async () => {
    await waitFor(() => registry.listDevices().length >= 10);
    const list = await devices();
    const names = list.map((device) => device.name);
    expect(names).toContain('Desk lamp');
    expect(names).toContain('Radiator valve');
    expect(names).toContain('Pool pump');
    // Coordinator is filtered.
    expect(names).not.toContain('Coordinator');
  });

  it('relays Zigbee state payloads into canonical typed state', async () => {
    await fake.publishAsync(
      'zigbee2mqtt/Desk lamp',
      JSON.stringify({ state: 'ON', brightness: 203, color_temp: 370, linkquality: 80 }),
    );
    await waitFor(() => {
      const lamp = registry.listDevices().find((device) => device.name === 'Desk lamp');
      return lamp?.endpoints[0]?.state.onOff === true;
    });
    const lamp = (await devices()).find((device) => device.name === 'Desk lamp')!;
    expect(lamp.endpoints[0]!.state).toMatchObject({
      onOff: true,
      level: { current: 203 },
      colorTemperature: { mireds: 370, minMireds: 250, maxMireds: 454 },
    });
  });

  it('routes a canonical command out as a Zigbee2MQTT /set publish', async () => {
    const lamp = (await devices()).find((device) => device.name === 'Desk lamp')!;
    observed.length = 0;
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${lamp.id}/endpoints/1/commands`,
      headers: auth(),
      payload: { type: 'setLevel', level: 128, transitionDs: 10 },
    });
    expect(response.statusCode).toBe(202);
    await waitFor(() => observed.some((message) => message.topic === 'zigbee2mqtt/Desk lamp/set'));
    const set = observed.find((message) => message.topic === 'zigbee2mqtt/Desk lamp/set')!;
    expect(JSON.parse(set.payload)).toEqual({ brightness: 128, transition: 1 });
  });

  it('round-trips the MQTT convention device: state in, command out', async () => {
    await fake.publishAsync(
      'gethome/device/pool-pump/state',
      JSON.stringify({ onOff: true, power: { activeMilliwatts: 740_000 } }),
      { retain: true },
    );
    await waitFor(() => {
      const pump = registry.listDevices().find((device) => device.name === 'Pool pump');
      return pump?.endpoints[0]?.state.onOff === true;
    });

    const pump = (await devices()).find((device) => device.name === 'Pool pump')!;
    expect(pump.endpoints[0]!.state).toMatchObject({ onOff: true, power: { activeMilliwatts: 740_000 } });

    observed.length = 0;
    await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${pump.id}/endpoints/1/commands`,
      headers: auth(),
      payload: { type: 'power', on: false },
    });
    await waitFor(() => observed.some((message) => message.topic === 'gethome/device/pool-pump/set'));
    const set = observed.find((message) => message.topic === 'gethome/device/pool-pump/set')!;
    expect(JSON.parse(set.payload)).toEqual({ type: 'power', on: false });
  });

  it('tracks availability topics', async () => {
    await fake.publishAsync('zigbee2mqtt/Desk lamp/availability', 'offline');
    await waitFor(() => {
      const lamp = registry.listDevices().find((device) => device.name === 'Desk lamp');
      return lamp?.online === false;
    });
    await fake.publishAsync('zigbee2mqtt/Desk lamp/availability', 'online');
    await waitFor(() => {
      const lamp = registry.listDevices().find((device) => device.name === 'Desk lamp');
      return lamp?.online === true;
    });
  });

  it('splits a two-channel relay into endpoints and addresses each channel', async () => {
    const relay = (await devices()).find((device) => device.name === 'Hallway relay')!;
    expect(relay.endpoints.map((endpoint) => endpoint.endpointId)).toEqual([1, 2]);

    await fake.publishAsync('zigbee2mqtt/Hallway relay', JSON.stringify({ state_l1: 'ON', state_l2: 'OFF', power: 3.5 }));
    await waitFor(() => {
      const current = registry.listDevices().find((device) => device.name === 'Hallway relay');
      return current?.endpoints.find((endpoint) => endpoint.endpointId === 2)?.state.onOff === false;
    });
    const current = registry.listDevices().find((device) => device.name === 'Hallway relay')!;
    expect(current.endpoints.find((endpoint) => endpoint.endpointId === 1)?.state.onOff).toBe(true);
    expect(current.endpoints.find((endpoint) => endpoint.endpointId === 1)?.state.power?.activeMilliwatts).toBe(3500);

    observed.length = 0;
    await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${relay.id}/endpoints/2/commands`,
      headers: auth(),
      payload: { type: 'power', on: true },
    });
    await waitFor(() => observed.some((message) => message.topic === 'zigbee2mqtt/Hallway relay/set'));
    const set = observed.find((message) => message.topic === 'zigbee2mqtt/Hallway relay/set')!;
    expect(JSON.parse(set.payload)).toEqual({ state_l2: 'ON' });
  });

  it('stamps event.at on MQTT convention presses that arrive without one', async () => {
    await fake.publishAsync(
      'gethome/discovery/doorbell/config',
      JSON.stringify({
        name: 'Doorbell button',
        endpoints: [{ endpointId: 1, deviceKind: 'remote', capabilities: ['event', 'battery'], primary: 'event' }],
      }),
      { retain: true },
    );
    await waitFor(() => registry.listDevices().some((device) => device.name === 'Doorbell button'));

    await fake.publishAsync(
      'gethome/device/doorbell/state',
      JSON.stringify({ event: { action: 'double', button: 'main', gesture: 'double' } }),
    );
    await waitFor(() => {
      const doorbell = registry.listDevices().find((device) => device.name === 'Doorbell button');
      return doorbell?.endpoints[0]?.state.event?.gesture === 'double';
    });
    const doorbell = registry.listDevices().find((device) => device.name === 'Doorbell button')!;
    expect(typeof doorbell.endpoints[0]!.state.event?.at).toBe('number');

    await fake.publishAsync('gethome/discovery/doorbell/config', '', { retain: true }).catch(() => {});
  });

  it('exposes device settings as generic custom fields and writes them back', async () => {
    // The TRV's child_lock (a settable binary) and preset (a settable enum)
    // have no typed capability — they surface as generic custom fields.
    const trv = (await devices()).find((device) => device.name === 'Radiator valve')!;
    const endpoint = trv.endpoints[0]!;
    expect(endpoint.capabilities).toContain('custom');
    const custom = endpoint.state.custom as {
      fields?: Array<{ id: string; control: string; settable: boolean }>;
      values?: Record<string, unknown>;
    };
    const fieldIds = (custom.fields ?? []).map((field) => field.id);
    expect(fieldIds).toContain('child_lock');
    expect(fieldIds).toContain('preset');

    // A state report populates the field values.
    await fake.publishAsync('zigbee2mqtt/Radiator valve', JSON.stringify({ child_lock: 'LOCK', preset: 'eco' }));
    await waitFor(() => {
      const current = registry.listDevices().find((device) => device.name === 'Radiator valve');
      return (current?.endpoints[0]?.state.custom?.values as Record<string, unknown>)?.preset === 'eco';
    });

    // Writing a field goes out on its own property, translating the toggle.
    observed.length = 0;
    await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${trv.id}/endpoints/1/commands`,
      headers: auth(),
      payload: { type: 'setCustomField', fieldId: 'child_lock', value: false },
    });
    await waitFor(() => observed.some((message) => message.topic === 'zigbee2mqtt/Radiator valve/set'));
    const set = observed.find((message) => message.topic === 'zigbee2mqtt/Radiator valve/set')!;
    expect(JSON.parse(set.payload)).toEqual({ child_lock: 'UNLOCK' });
  });

  it('runs the IR blaster flow: learn → capture → save → send', async () => {
    const current = () => registry.listDevices().find((device) => device.name === 'Living room IR');
    const irState = () => current()?.endpoints.find((endpoint) => endpoint.endpointId === 1)?.state.irRemote;

    await waitFor(() => current() !== undefined);
    const device = current()!;
    expect(device.endpoints[0]!.capabilities).toContain('irRemote');
    // The library base is seeded even before anything is learned.
    expect(irState()).toEqual({ learning: false, commands: [] });

    const command = (payload: unknown) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/devices/${device.id}/endpoints/1/commands`,
        headers: auth(),
        payload,
      });
    const lastSet = () =>
      observed.filter((message) => message.topic === 'zigbee2mqtt/Living room IR/set').at(-1);

    // Enter learn mode → publishes learn_ir_code, reflects the flag.
    observed.length = 0;
    await command({ type: 'irLearn', on: true });
    await waitFor(() => lastSet() !== undefined);
    expect(JSON.parse(lastSet()!.payload)).toEqual({ learn_ir_code: 'ON' });
    await waitFor(() => irState()?.learning === true);

    // The device captures a code off a physical remote.
    await fake.publishAsync('zigbee2mqtt/Living room IR', JSON.stringify({ learned_ir_code: 'RAW_TV_POWER==' }));
    await waitFor(() => irState()?.pendingCode === 'RAW_TV_POWER==');
    expect(irState()?.learning).toBe(false);

    // Name and save it.
    await command({ type: 'irSaveLearned', name: 'TV Power' });
    await waitFor(() => (irState()?.commands.length ?? 0) === 1);
    const saved = irState()!.commands[0]!;
    expect(saved.name).toBe('TV Power');
    expect(saved.code).toBe('RAW_TV_POWER==');
    expect(irState()?.pendingCode).toBeUndefined();

    // Send it → the opaque blob goes out on ir_code_to_send.
    observed.length = 0;
    await command({ type: 'irSend', commandId: saved.id });
    await waitFor(() => lastSet() !== undefined);
    expect(JSON.parse(lastSet()!.payload)).toEqual({ ir_code_to_send: 'RAW_TV_POWER==' });

    // Rename, then delete — the library reflects both.
    await command({ type: 'irRenameCommand', commandId: saved.id, name: 'Telly' });
    await waitFor(() => irState()?.commands[0]?.name === 'Telly');
    await command({ type: 'irDeleteCommand', commandId: saved.id });
    await waitFor(() => (irState()?.commands.length ?? 0) === 0);
  });

  it('serves a remote with its button inventory and relays presses as events', async () => {
    // The inventory is seeded at adoption, before any press.
    await waitFor(() => {
      const remote = registry.listDevices().find((device) => device.name === 'Bedside remote');
      return (remote?.endpoints[0]?.state.event?.buttons?.length ?? 0) === 3;
    });

    await fake.publishAsync('zigbee2mqtt/Bedside remote', JSON.stringify({ action: 'double_left', battery: 97 }));
    await waitFor(() => {
      const remote = registry.listDevices().find((device) => device.name === 'Bedside remote');
      return remote?.endpoints[0]?.state.event?.gesture === 'double';
    });
    const remote = (await devices()).find((device) => device.name === 'Bedside remote')!;
    expect(remote.endpoints[0]!.capabilities).toContain('event');
    expect(remote.endpoints[0]!.state).toMatchObject({
      event: { action: 'double_left', button: 'left', gesture: 'double' },
      battery: { percent: 97 },
    });
  });
});
