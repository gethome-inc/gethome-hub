import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import mqtt from 'mqtt';
import { ZigbeeAdapter, type AppliedAiMapping } from '../../src/adapters/zigbee/adapter.js';
import { exposesHash } from '../../src/adapters/zigbee/exposes-mapper.js';
import type { AdapterBus, AdapterDeviceDescriptor } from '../../src/adapters/adapter.js';
import type { EndpointState } from '../../src/schema/index.js';

/**
 * Zigbee adapter behavior over a real broker, with a scripted AI assist:
 * the runtime unknown-parameter trigger and the AI-over-static overlay.
 * Gated on HUB_TEST_MQTT=1 like the round-trip e2e (no database needed).
 */
const enabled = process.env.HUB_TEST_MQTT === '1';
const MQTT_URL = process.env.HUB_TEST_MQTT_URL ?? 'mqtt://127.0.0.1:1883';
const BASE = `z2m-test-${Math.random().toString(16).slice(2, 8)}`;

const waitFor = async (predicate: () => boolean, timeoutMs = 8000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const probe = {
  ieee_address: '0xfeed000000000001',
  friendly_name: 'Weird probe',
  type: 'EndDevice',
  supported: true,
  interview_completed: true,
  definition: {
    vendor: 'Acme',
    model: 'PROBE-1',
    description: 'Mystery probe',
    exposes: [
      { type: 'numeric', name: 'temperature', property: 'temperature', access: 1, unit: '°C' },
      { type: 'numeric', name: 'linkquality', property: 'linkquality', access: 1 },
    ],
  },
};

describe.skipIf(!enabled)('ZigbeeAdapter runtime AI adaptation', () => {
  let fake: mqtt.MqttClient;
  let adapter: ZigbeeAdapter;

  const upserts: AdapterDeviceDescriptor[] = [];
  const patches: Array<{ endpointId: number; patch: Partial<EndpointState> }> = [];
  const failures: Array<{ property: string; kind: string; detail: string }> = [];
  const reachability: Array<{ externalId: string; reachable: boolean }> = [];
  const bus: AdapterBus = {
    deviceUpserted: (descriptor) => upserts.push(descriptor),
    deviceRemoved: () => {},
    stateChanged: (_adapter, _externalId, endpointId, patch) => patches.push({ endpointId, patch }),
    reachabilityChanged: (_adapter, externalId, reachable) =>
      reachability.push({ externalId, reachable }),
    radioReachabilityChanged: () => {},
    commandFailed: (_adapter, _externalId, failure) => failures.push(failure),
    activity: () => {},
  };

  const humidityMapping: AppliedAiMapping = {
    endpoints: [{ endpointId: 1, deviceKind: 'sensor', capabilities: ['temperature', 'humidity'], primary: 'humidity' }],
    properties: new Set(['soil_moisture']),
    // Everything this mapping reads it reads onto a *typed* capability
    // (humidity), which is what tells the adapter not to leave a generic
    // custom field standing for the same key.
    typedProperties: new Set(['soil_moisture']),
    extractState: (payload) => {
      const moisture = payload.soil_moisture;
      const map = new Map<number, Partial<EndpointState>>();
      if (typeof moisture === 'number') {
        map.set(1, { sensors: { humidityCenti: Math.round(moisture * 100) } });
      }
      return map;
    },
    buildCommandPayload: () => null,
  };

  const requestMapping = vi.fn(async () => null as AppliedAiMapping | null);

  /**
   * How many times adoption asked the agent, read while the answer still
   * exists.
   *
   * This suite is a *sequence* — one adapter, one broker, one mock, each test
   * standing on what the one before it did — and `mock.calls` deliberately is
   * not: vitest clears every mock's history before each test, so a count read
   * in a test body is about that test alone. That is the right default and
   * every assertion below is written to it, but it wipes what `beforeAll`
   * did before the first test can look — which would have turned the
   * assertion under it into one that cannot fail. So the one fact this suite
   * needs about the hook is taken in the hook.
   */
  let asksDuringAdoption = -1;

  beforeAll(async () => {
    fake = await mqtt.connectAsync(MQTT_URL);
    await fake.publishAsync(`${BASE}/bridge/devices`, JSON.stringify([probe]), { retain: true });

    adapter = new ZigbeeAdapter({
      mqttUrl: MQTT_URL,
      baseTopic: BASE,
      log: pino({ level: 'silent' }),
      aiAssist: { requestMapping },
      parameterRemapDelayMs: 50,
    });
    await adapter.start(bus);
    await waitFor(() => upserts.length >= 1);
    asksDuringAdoption = requestMapping.mock.calls.length;
  }, 30_000);

  afterAll(async () => {
    await fake?.publishAsync(`${BASE}/bridge/devices`, '', { retain: true }).catch(() => {});
    await fake?.endAsync().catch(() => {});
    await adapter?.stop();
  });

  it('adopts fully-mapped devices without asking the AI', () => {
    expect(upserts[0]).toMatchObject({
      adapter: 'zigbee',
      externalId: probe.ieee_address,
      needsReview: false,
    });
    expect(asksDuringAdoption).toBe(0);
  });

  it('asks the AI once when an undeclared parameter appears, with samples', async () => {
    requestMapping.mockResolvedValueOnce(humidityMapping);

    await fake.publishAsync(`${BASE}/Weird probe`, JSON.stringify({ temperature: 20.1, soil_moisture: 41 }));
    await waitFor(() => requestMapping.mock.calls.length === 1);
    const [, staticProfile, options] = requestMapping.mock.calls[0]! as unknown as [
      unknown,
      { unmapped: string[] },
      { samples?: Record<string, unknown>[]; force?: boolean },
    ];
    expect(staticProfile.unmapped).toEqual([]);
    // **Consulted, never forced.** A new parameter is a reason to ask what
    // this hub already knows about the model, not a reason to throw that away
    // and pay for a fresh run: forcing meant a model that had been recognised
    // was re-recognised every time one more property turned up, and
    // `aiAskedKeys` is in-memory, so every restart began the sequence again.
    // Four paid runs on one plug in an hour is what that looked like.
    expect(options.force).toBeUndefined();
    expect(options.samples?.at(-1)).toMatchObject({ soil_moisture: 41 });

    // The remap re-announces with the AI capabilities merged in.
    await waitFor(() => upserts.some((descriptor) => descriptor.endpoints[0]?.capabilities.includes('humidity')));

    // Later payloads run static + AI overlay together.
    patches.length = 0;
    await fake.publishAsync(`${BASE}/Weird probe`, JSON.stringify({ temperature: 21.5, soil_moisture: 44 }));
    await waitFor(() =>
      patches.some(
        (entry) =>
          entry.patch.sensors?.temperatureCenti === 2150 && entry.patch.sensors?.humidityCenti === 4400,
      ),
    );
  });

  it('does not re-ask for a parameter it already asked about', async () => {
    await fake.publishAsync(`${BASE}/Weird probe`, JSON.stringify({ temperature: 22, soil_moisture: 45 }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(requestMapping).not.toHaveBeenCalled();
  });

  it('answers an explicit remap while the agent is still working', async () => {
    // `POST /devices/:id/remap` hands its answer straight back to an app, and
    // a run is minutes against a ten-second client timeout — so what is being
    // pinned here is that the answer arrives *now*. A remap that awaited the
    // run reported a failure on every retry that actually did any work.
    let release!: () => void;
    const working = new Promise<void>((resolve) => {
      release = resolve;
    });
    requestMapping.mockImplementationOnce(async () => {
      await working;
      return null;
    });

    try {
      // Not awaited, and not awaitable: a promise here would fail this.
      expect(adapter.remap(probe.ieee_address)).toBe(true);
      // The run really did start — an answer that came back because nothing
      // happened would be the bug this replaced, wearing the same face.
      await waitFor(() => requestMapping.mock.calls.length === 1);
      // Same cast as above: the mock is declared with no parameters, so its
      // recorded arguments need spelling out.
      const [, , options] = requestMapping.mock.calls[0]! as unknown as [
        unknown,
        unknown,
        { force?: boolean },
      ];
      expect(options).toMatchObject({ force: true });
    } finally {
      release();
    }
  });

  /**
   * The bug that left a plug reading offline on a hub whose radio was fine.
   *
   * `adoptDevice` used to put the device into the two maps `handleMessage`
   * routes by **after** awaiting the agent — so for the tens of seconds a run
   * takes, every state report and every `<name>/availability` message for it
   * was looked up, missed, and dropped. On the first adoption after a restart
   * there is no earlier entry at all, and that is exactly when Zigbee2MQTT
   * republishes its retained availability: the hub threw away the one message
   * saying the device was back, and the row kept the `offline` it had been
   * read out of SQLite with.
   */
  it('still routes a device’s messages while its mapping run is in flight', async () => {
    let release!: () => void;
    const working = new Promise<void>((resolve) => {
      release = resolve;
    });
    requestMapping.mockImplementationOnce(async () => {
      await working;
      return null;
    });

    const newcomer = {
      ...probe,
      ieee_address: '0xfeed000000000002',
      friendly_name: 'Slow probe',
      definition: {
        ...probe.definition,
        model: 'PROBE-2',
        // A composite nothing static can place, so adoption asks the agent.
        exposes: [...probe.definition.exposes, { type: 'composite', name: 'odd', property: 'odd', access: 3, features: [] }],
      },
    };

    reachability.length = 0;
    await fake.publishAsync(`${BASE}/bridge/devices`, JSON.stringify([probe, newcomer]), { retain: true });
    // The newcomer's run has actually begun — everything below depends on it
    // being *in flight*. This used to wait on the suite's running total,
    // which the test before it had already carried past the number, so the
    // wait returned at once and the publish below raced the adoption it
    // exists to interrupt.
    await waitFor(() => requestMapping.mock.calls.length >= 1);

    try {
      // Mid-run: the device is not yet announced, but it must already be
      // reachable — this is the retained availability Z2M republishes.
      await fake.publishAsync(`${BASE}/Slow probe/availability`, JSON.stringify({ state: 'online' }));
      await waitFor(() =>
        reachability.some((entry) => entry.externalId === newcomer.ieee_address && entry.reachable),
      );
    } finally {
      release();
    }
  });

  /**
   * The one that made a working plug look dead.
   *
   * `primary` is the single field every app draws a tile from — a switch, a
   * dimmer, a reading — and `custom` is layer 2's generic catch-all, which
   * renders as no control at all. The merge took the agent's `primary`
   * unconditionally, so a mapping that named `custom` turned a plug whose
   * `onOff` was still right there in `capabilities` into a grey tile with
   * nothing on it, on a hub that went on reporting the device perfectly
   * online. Adding capabilities is the agent's job; demoting the one the
   * apps render is not.
   */
  it('forgets a stored mapping without buying a replacement', async () => {
    // Give the device a mapping first, the way an upload or a run would.
    requestMapping.mockResolvedValueOnce(humidityMapping);
    expect(adapter.remap(probe.ieee_address)).toBe(true);
    await waitFor(() =>
      upserts.some(
        (entry) =>
          entry.externalId === probe.ieee_address &&
          (entry.endpoints[0]?.capabilities ?? []).includes('humidity'),
      ),
    );

    const runsBefore = requestMapping.mock.calls.length;
    upserts.length = 0;

    // Pressing Forget. The library row is gone by the time this is called, so
    // asking the agent here would find no cache and start a paid run — inside
    // a request whose client gives up after ten seconds.
    await adapter.forgetStoredMapping(exposesHash(probe as unknown as Parameters<typeof exposesHash>[0]));

    expect(requestMapping.mock.calls.length).toBe(runsBefore);
    const endpoint = upserts.at(-1)!.endpoints[0]!;
    // Back to what the static mapper alone makes of it.
    expect(endpoint.capabilities).not.toContain('humidity');
    expect(endpoint.capabilities.length).toBeGreaterThan(0);
  });

  it('lets the agent add capabilities but never demote the primary one', async () => {
    requestMapping.mockResolvedValueOnce({
      endpoints: [
        { endpointId: 1, deviceKind: 'outlet', capabilities: ['custom'], primary: 'custom' },
      ],
      properties: new Set(['voltage']),
      typedProperties: new Set(),
      extractState: () => new Map(),
      buildCommandPayload: () => null,
    } as AppliedAiMapping);

    upserts.length = 0;
    expect(adapter.remap(probe.ieee_address)).toBe(true);
    await waitFor(() => upserts.some((entry) => entry.externalId === probe.ieee_address));

    const endpoint = upserts.at(-1)!.endpoints[0]!;
    // The generic field arrives…
    expect(endpoint.capabilities).toContain('custom');
    // …beside what the device already had, and the tile still has something
    // to draw.
    expect(endpoint.capabilities.length).toBeGreaterThan(1);
    expect(endpoint.primary).not.toBe('custom');
  });

  it('answers false for a device the radio has no schema for', () => {
    // A device row can outlive its `bridge/devices` entry, and that is a
    // different answer from a run that failed — the only one that can be
    // given without waiting.
    expect(adapter.remap('0x0000000000000000')).toBe(false);
  });
});

/**
 * The boot burst: a broker replays every retained message the instant we
 * subscribe, so `bridge/devices` — the only thing that names a device — and
 * the `<name>/availability` readings about those devices arrive together.
 * Two devices, because the first is registered synchronously inside the
 * `bridge/devices` handler and only the ones behind it are exposed to the
 * gap: `syncDevices` suspends on device 1, so device 2 is still nameless
 * when its own retained availability is dispatched.
 */
describe.skipIf(!enabled)('ZigbeeAdapter retained availability at start-up', () => {
  const base = `z2m-avail-${Math.random().toString(16).slice(2, 8)}`;
  let fake: mqtt.MqttClient;
  let adapter: ZigbeeAdapter;

  const first = { ...probe, ieee_address: '0xfeed0000000000a1', friendly_name: 'avail one' };
  const second = { ...probe, ieee_address: '0xfeed0000000000a2', friendly_name: 'avail two' };

  const upserts: AdapterDeviceDescriptor[] = [];
  const reachability: Array<{ externalId: string; reachable: boolean }> = [];
  const bus: AdapterBus = {
    deviceUpserted: (descriptor) => upserts.push(descriptor),
    deviceRemoved: () => {},
    stateChanged: () => {},
    reachabilityChanged: (_adapter, externalId, reachable) =>
      reachability.push({ externalId, reachable }),
    radioReachabilityChanged: () => {},
    commandFailed: () => {},
    activity: () => {},
  };

  beforeAll(async () => {
    fake = await mqtt.connectAsync(MQTT_URL);
    await fake.publishAsync(`${base}/bridge/devices`, JSON.stringify([first, second]), {
      retain: true,
    });
    // Exactly what Zigbee2MQTT leaves behind for a device that is away: one
    // retained message, and no further publish until it comes back. Drop it
    // and the hub has nothing left to learn the absence from.
    await fake.publishAsync(`${base}/${second.friendly_name}/availability`, '{"state":"offline"}', {
      retain: true,
    });

    adapter = new ZigbeeAdapter({
      mqttUrl: MQTT_URL,
      baseTopic: base,
      log: pino({ level: 'silent' }),
      parameterRemapDelayMs: 50,
    });
    await adapter.start(bus);
    await waitFor(() => upserts.length >= 2);
  }, 30_000);

  afterAll(async () => {
    await fake?.publishAsync(`${base}/bridge/devices`, '', { retain: true }).catch(() => {});
    await fake
      ?.publishAsync(`${base}/${second.friendly_name}/availability`, '', { retain: true })
      .catch(() => {});
    await fake?.endAsync().catch(() => {});
    await adapter?.stop();
  });

  it('keeps availability that arrived before the device it is about', async () => {
    await waitFor(() => reachability.some((entry) => entry.externalId === second.ieee_address));
    expect(reachability).toContainEqual({ externalId: second.ieee_address, reachable: false });
  });
});

/**
 * An overlay adds to the static mapping; it must never take anything away —
 * and the merge that combines the two reports had been quietly taking things
 * away for as long as generic fields have existed.
 *
 * `custom.values` is the one shape in `EndpointState` that is two levels
 * deep, and the adapter combined the two patches with a merge that recursed
 * once. So the moment a mapping declared a generic field of its own, its
 * `values` object replaced the static mapper's wholesale: the inventory went
 * on advertising every static field and not one of them ever received another
 * value. Seen on a real Aqara SP-EUC01 whose six settings — the power-outage
 * memory, the night LED, auto-off among them — went blank behind an uploaded
 * schema that named three fields, and read as controls the plug had stopped
 * answering.
 */
describe.skipIf(!enabled)('ZigbeeAdapter overlay merge', () => {
  const base = `z2m-merge-${Math.random().toString(16).slice(2, 8)}`;
  let fake: mqtt.MqttClient;
  let adapter: ZigbeeAdapter;

  /** A plug with a typed control and two settings the static mapper fields. */
  const plug = {
    ieee_address: '0xfeed0000000000b1',
    friendly_name: 'merge plug',
    type: 'Router',
    supported: true,
    interview_completed: true,
    definition: {
      vendor: 'Acme',
      model: 'PLUG-M1',
      description: 'Metered plug',
      exposes: [
        {
          type: 'switch',
          features: [
            { type: 'binary', name: 'state', property: 'state', access: 7, value_on: 'ON', value_off: 'OFF' },
          ],
        },
        { type: 'binary', name: 'auto_off', property: 'auto_off', access: 7, value_on: true, value_off: false },
        {
          type: 'binary',
          name: 'led_disabled_night',
          property: 'led_disabled_night',
          access: 7,
          value_on: true,
          value_off: false,
        },
      ],
    },
  };

  /** What an uploaded or agent-written mapping looks like when it declares a
   *  generic field of its own — here for a property the static mapper
   *  deliberately ignores. */
  const overlay: AppliedAiMapping = {
    source: 'imported',
    endpoints: [
      {
        endpointId: 1,
        deviceKind: 'outlet',
        capabilities: ['custom'],
        primary: 'custom',
        customFields: [{ id: 'voltage', label: 'Voltage', control: 'value', unit: 'V', settable: false }],
      },
    ],
    properties: new Set(['voltage']),
    typedProperties: new Set(),
    extractState: (payload) =>
      typeof payload.voltage === 'number'
        ? new Map([[1, { custom: { values: { voltage: payload.voltage } } }]])
        : new Map(),
    buildCommandPayload: () => null,
  };

  const patches: Array<{ endpointId: number; patch: Partial<EndpointState> }> = [];
  const upserts: AdapterDeviceDescriptor[] = [];
  const bus: AdapterBus = {
    deviceUpserted: (descriptor) => upserts.push(descriptor),
    deviceRemoved: () => {},
    stateChanged: (_adapter, _externalId, endpointId, patch) => patches.push({ endpointId, patch }),
    reachabilityChanged: () => {},
    radioReachabilityChanged: () => {},
    commandFailed: () => {},
    activity: () => {},
  };

  beforeAll(async () => {
    fake = await mqtt.connectAsync(MQTT_URL);
    await fake.publishAsync(`${base}/bridge/devices`, JSON.stringify([plug]), { retain: true });
    adapter = new ZigbeeAdapter({
      mqttUrl: MQTT_URL,
      baseTopic: base,
      log: pino({ level: 'silent' }),
      aiAssist: { requestMapping: async () => overlay },
    });
    await adapter.start(bus);
    await waitFor(() => upserts.length >= 1);
    // The library-apply path: what an upload or a repair has just written.
    await adapter.applyStoredMapping(
      exposesHash(plug as unknown as Parameters<typeof exposesHash>[0]),
    );
  }, 30_000);

  afterAll(async () => {
    await fake?.publishAsync(`${base}/bridge/devices`, '', { retain: true }).catch(() => {});
    await fake?.endAsync().catch(() => {});
    await adapter?.stop();
  });

  it('keeps the static generic fields reporting beside the overlay\'s own', async () => {
    patches.length = 0;
    await fake.publishAsync(
      `${base}/${plug.friendly_name}`,
      JSON.stringify({ state: 'ON', auto_off: true, led_disabled_night: false, voltage: 231 }),
    );
    await waitFor(() => patches.some((entry) => entry.patch.custom?.values !== undefined));

    const values = patches.at(-1)!.patch.custom!.values!;
    // The overlay's own field arrives…
    expect(values.voltage).toBe(231);
    // …and so does every field the static mapper reads, which is the half
    // that used to vanish.
    expect(values.auto_off).toBe(true);
    expect(values.led_disabled_night).toBe(false);
    // Nothing else was lost either: the typed capability still reports.
    expect(patches.at(-1)!.patch.onOff).toBe(true);
  });
});

/**
 * Taking a device off the network, against a fake Zigbee2MQTT that answers
 * `bridge/request/device/remove` the way the real one does: a device that
 * cannot answer is refused when asked plainly, kept in Zigbee2MQTT's database,
 * and handed back in its retained device list on the next start — as a new
 * device, after somebody removed it. So a refusal is followed by a forced
 * removal, and until the bridge's own list lets the device go nothing it
 * publishes about it is adopted again.
 */
describe.skipIf(!enabled)('ZigbeeAdapter taking a device off the network', () => {
  const base = `z2m-forget-${Math.random().toString(16).slice(2, 8)}`;
  let fake: mqtt.MqttClient;
  let adapter: ZigbeeAdapter;

  const lamp = { ...probe, ieee_address: '0xfeed0000000000c1', friendly_name: 'forget lamp' };
  const sensor = { ...probe, ieee_address: '0xfeed0000000000c2', friendly_name: 'forget sensor' };
  let onBridge = [lamp, sensor];

  /** What the fake bridge was asked, in order. */
  const asked: Array<{ id?: string; force?: boolean; transaction?: string }> = [];
  /** How the fake bridge answers a plain removal: as for a device that is away, unless told otherwise. */
  let plainRemovalWorks = false;

  const upserts: AdapterDeviceDescriptor[] = [];
  const bus: AdapterBus = {
    deviceUpserted: (descriptor) => upserts.push(descriptor),
    deviceRemoved: () => {},
    stateChanged: () => {},
    reachabilityChanged: () => {},
    radioReachabilityChanged: () => {},
    commandFailed: () => {},
    activity: () => {},
  };
  const upsertsOf = (ieee: string) => upserts.filter((descriptor) => descriptor.externalId === ieee).length;

  const publishList = () =>
    fake.publishAsync(`${base}/bridge/devices`, JSON.stringify(onBridge), { retain: true });

  beforeAll(async () => {
    fake = await mqtt.connectAsync(MQTT_URL);
    await fake.publishAsync(`${base}/bridge/state`, '{"state":"online"}', { retain: true });
    await publishList();
    await fake.subscribeAsync(`${base}/bridge/request/device/remove`);
    fake.on('message', (topic, payload) => {
      if (topic !== `${base}/bridge/request/device/remove`) return;
      const request = JSON.parse(payload.toString()) as { id?: string; force?: boolean; transaction?: string };
      asked.push(request);
      void (async () => {
        if (!request.force && !plainRemovalWorks) {
          // The bridge republishes its list for reasons of its own while the
          // device is being asked — still naming the device. That must not
          // bring it back.
          await publishList();
          await fake.publishAsync(
            `${base}/bridge/response/device/remove`,
            JSON.stringify({
              data: {},
              status: 'error',
              error: `Failed to remove device '${request.id}' (block: false, force: false) (Error: ZDO timeout)`,
              transaction: request.transaction,
            }),
          );
          return;
        }
        // Zigbee2MQTT publishes its list without the device, then answers.
        onBridge = onBridge.filter((device) => device.ieee_address !== request.id);
        await publishList();
        await fake.publishAsync(
          `${base}/bridge/response/device/remove`,
          JSON.stringify({
            data: { id: request.id, block: false, force: request.force === true },
            status: 'ok',
            transaction: request.transaction,
          }),
        );
      })();
    });

    adapter = new ZigbeeAdapter({
      mqttUrl: MQTT_URL,
      baseTopic: base,
      log: pino({ level: 'silent' }),
      parameterRemapDelayMs: 50,
    });
    await adapter.start(bus);
    await waitFor(() => upsertsOf(lamp.ieee_address) === 1 && upsertsOf(sensor.ieee_address) === 1);
  }, 30_000);

  afterAll(async () => {
    await fake?.publishAsync(`${base}/bridge/devices`, '', { retain: true }).catch(() => {});
    await fake?.publishAsync(`${base}/bridge/state`, '', { retain: true }).catch(() => {});
    await fake?.endAsync().catch(() => {});
    await adapter?.stop();
  });

  it('removes a device that cannot answer by force, and does not adopt it again meanwhile', async () => {
    let settled = false;
    void adapter.forget(lamp.ieee_address).then(() => {
      settled = true;
    });
    await waitFor(() => settled);

    expect(asked.map(({ id, force }) => ({ id, force }))).toEqual([
      { id: lamp.ieee_address, force: undefined },
      { id: lamp.ieee_address, force: true },
    ]);
    // Each request carried its own transaction, which is how its answer was found.
    expect(new Set(asked.map((request) => request.transaction)).size).toBe(2);
    // The republish that still named it, and the one after: neither adopted it.
    expect(upsertsOf(lamp.ieee_address)).toBe(1);
    // A report about it is a stranger's now.
    await fake.publishAsync(`${base}/${lamp.friendly_name}`, JSON.stringify({ temperature: 19 }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(upsertsOf(lamp.ieee_address)).toBe(1);
  });

  it('settles at once for a device the bridge no longer has', async () => {
    asked.length = 0;
    let settled = false;
    void adapter.forget(lamp.ieee_address).then(() => {
      settled = true;
    });
    await waitFor(() => settled);
    expect(asked).toEqual([]);
  });

  it('can adopt a device again once the bridge let it go and it was paired again', async () => {
    onBridge = [...onBridge, lamp];
    await publishList();
    await waitFor(() => upsertsOf(lamp.ieee_address) === 2);
  });

  it('waits for a bridge that is not running, and asks the moment it is back', async () => {
    asked.length = 0;
    plainRemovalWorks = true;
    await fake.publishAsync(`${base}/bridge/state`, '{"state":"offline"}', { retain: true });
    await new Promise((resolve) => setTimeout(resolve, 200));

    let settled = false;
    void adapter.forget(sensor.ieee_address).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Nobody to hear it, so nothing was said — and nothing settled.
    expect(asked).toEqual([]);
    expect(settled).toBe(false);

    await fake.publishAsync(`${base}/bridge/state`, '{"state":"online"}', { retain: true });
    await waitFor(() => settled);
    // A device that answers leaves when asked, with no force needed.
    expect(asked.map(({ id, force }) => ({ id, force }))).toEqual([{ id: sensor.ieee_address, force: undefined }]);
  });
});
