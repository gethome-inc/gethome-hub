import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import {
  applyStateRules,
  buildCommandPayload,
  mappingDescriptorSchema,
  sanityCheckDescriptor,
  type MappingDescriptor,
} from '../src/ai/descriptor.js';
import { AiDeviceMapper, exposesHash } from '../src/ai/mapper.js';
import { AiUnavailableError } from '../src/ai/errors.js';
import { SettingsService } from '../src/core/settings.js';
import type { Z2mDevice } from '../src/adapters/zigbee/exposes-mapper.js';
import { mapExposes } from '../src/adapters/zigbee/exposes-mapper.js';
import { openTestDb, resetDb } from './helpers/db.js';

const dimmerDescriptor: MappingDescriptor = {
  version: 1,
  endpoints: [
    {
      endpointId: 1,
      deviceKind: 'light',
      capabilities: ['onOff', 'level'],
      primary: 'onOff',
      stateRules: [
        { property: 'state', to: 'onOff', transform: { kind: 'enumMap', map: { ON: 1, OFF: 0 } } },
        {
          property: 'dim_level',
          to: 'level.current',
          transform: { kind: 'scale', fromMin: 0, fromMax: 1000, toMin: 1, toMax: 254 },
        },
      ],
      commandRules: [
        { intent: 'power', property: 'state', transform: { kind: 'boolMap', whenTrue: 'ON', whenFalse: 'OFF' } },
        {
          intent: 'setLevel',
          property: 'dim_level',
          transform: { kind: 'scale', fromMin: 1, fromMax: 254, toMin: 0, toMax: 1000 },
        },
      ],
    },
  ],
};

describe('MappingDescriptor validation', () => {
  it('accepts a well-formed descriptor', () => {
    expect(mappingDescriptorSchema.parse(dimmerDescriptor)).toBeTruthy();
    expect(sanityCheckDescriptor(dimmerDescriptor)).toEqual([]);
  });

  it('rejects unknown state paths, capabilities, and transforms', () => {
    expect(() =>
      mappingDescriptorSchema.parse({
        version: 1,
        endpoints: [
          {
            endpointId: 1,
            deviceKind: 'light',
            capabilities: ['onOff'],
            primary: 'onOff',
            stateRules: [{ property: 'x', to: 'selfDestruct' }],
            commandRules: [],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      mappingDescriptorSchema.parse({
        version: 1,
        endpoints: [
          {
            endpointId: 1,
            deviceKind: 'nuclear_reactor',
            capabilities: ['onOff'],
            primary: 'onOff',
            stateRules: [],
            commandRules: [],
          },
        ],
      }),
    ).toThrow();
  });

  it('flags rules writing paths for undeclared capabilities', () => {
    const problems = sanityCheckDescriptor({
      version: 1,
      endpoints: [
        {
          endpointId: 1,
          deviceKind: 'sensor',
          capabilities: ['temperature'],
          primary: 'temperature',
          stateRules: [{ property: 'lock', to: 'lock' }],
          commandRules: [],
        },
      ],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('doorLock');
  });
});

describe('MappingDescriptor interpreter', () => {
  it('extracts state through scale and enumMap transforms', () => {
    const patches = applyStateRules(dimmerDescriptor, { state: 'ON', dim_level: 500 });
    const patch = patches.get(1)!;
    expect(patch.onOff).toBe(true);
    // 500/1000 → halfway between 1 and 254 ≈ 128 (rounded).
    expect(patch.level?.current).toBe(128);
    expect(patch.level?.min).toBe(1);
    expect(patch.level?.max).toBe(254);
  });

  it('applies celsiusToCenti, invertPercentTo100ths, and boolMap', () => {
    const descriptor: MappingDescriptor = {
      version: 1,
      endpoints: [
        {
          endpointId: 1,
          deviceKind: 'climate',
          capabilities: ['temperature', 'windowCovering', 'smokeCOAlarm'],
          primary: 'temperature',
          stateRules: [
            { property: 'temp', to: 'sensors.temperatureCenti', transform: { kind: 'celsiusToCenti' } },
            {
              property: 'shade_pct',
              to: 'covering.currentPositionLiftPercent100ths',
              transform: { kind: 'invertPercentTo100ths' },
            },
            {
              property: 'alarm',
              to: 'sensors.smokeAlarm',
              transform: { kind: 'boolMap', whenTrue: 2, whenFalse: 0 },
            },
          ],
          commandRules: [],
        },
      ],
    };
    const patch = applyStateRules(descriptor, { temp: 21.5, shade_pct: 75, alarm: true }).get(1)!;
    expect(patch.sensors?.temperatureCenti).toBe(2150);
    expect(patch.covering?.currentPositionLiftPercent100ths).toBe(2500);
    expect(patch.sensors?.smokeAlarm).toBe(2);
  });

  it('reads dotted payload paths and skips missing values', () => {
    const descriptor: MappingDescriptor = {
      version: 1,
      endpoints: [
        {
          endpointId: 1,
          deviceKind: 'light',
          capabilities: ['color'],
          primary: 'color',
          stateRules: [
            {
              property: 'color.h',
              to: 'colorHS.hue',
              transform: { kind: 'scale', fromMin: 0, fromMax: 360, toMin: 0, toMax: 254 },
            },
          ],
          commandRules: [],
        },
      ],
    };
    expect(applyStateRules(descriptor, { color: { h: 180 } }).get(1)!.colorHS?.hue).toBe(127);
    expect(applyStateRules(descriptor, { other: 1 }).get(1)).toEqual({});
  });

  it('routes multi-endpoint payload properties to their endpoints', () => {
    const twoRelay: MappingDescriptor = {
      version: 1,
      endpoints: [1, 2].map((endpointId) => ({
        endpointId,
        deviceKind: 'outlet' as const,
        capabilities: ['onOff' as const],
        primary: 'onOff' as const,
        stateRules: [
          {
            property: `state_l${endpointId}`,
            to: 'onOff' as const,
            transform: { kind: 'enumMap' as const, map: { ON: 1, OFF: 0 } },
          },
        ],
        commandRules: [],
      })),
    };
    const patches = applyStateRules(twoRelay, { state_l1: 'ON', state_l2: 'OFF' });
    expect(patches.get(1)!.onOff).toBe(true);
    expect(patches.get(2)!.onOff).toBe(false);
  });

  it('maps string enums onto event paths and stamps the occurrence time', () => {
    const remote: MappingDescriptor = {
      version: 1,
      endpoints: [
        {
          endpointId: 1,
          deviceKind: 'remote',
          capabilities: ['event'],
          primary: 'event',
          stateRules: [
            { property: 'presence_event', to: 'event.action' },
            {
              property: 'presence_event',
              to: 'event.gesture',
              transform: { kind: 'enumMap', map: { enter: 'single', leave: 'release' } },
            },
          ],
          commandRules: [],
        },
      ],
    };
    expect(sanityCheckDescriptor(remote)).toEqual([]);
    const patch = applyStateRules(remote, { presence_event: 'enter' }).get(1)!;
    expect(patch.event?.action).toBe('enter');
    expect(patch.event?.gesture).toBe('single');
    expect(typeof patch.event?.at).toBe('number');
    // No event in the payload → no stamped patch.
    expect(applyStateRules(remote, { other: 1 }).get(1)).toEqual({});
  });

  it('declares generic custom fields and reads/writes them without stateRules', () => {
    const descriptor: MappingDescriptor = {
      version: 1,
      endpoints: [
        {
          endpointId: 1,
          deviceKind: 'sensor',
          capabilities: ['custom'],
          primary: 'custom',
          stateRules: [],
          commandRules: [],
          customFields: [
            {
              id: 'mode',
              label: 'Mode',
              control: 'select',
              settable: true,
              options: [
                { value: 'a', label: 'A' },
                { value: 'b', label: 'B' },
              ],
            },
            { id: 'lock', label: 'Lock', control: 'toggle', settable: true, onValue: 'ON', offValue: 'OFF' },
            { id: 'probe', label: 'Probe', control: 'value', settable: false, unit: '°C' },
          ],
        },
      ],
    };
    expect(sanityCheckDescriptor(descriptor)).toEqual([]);
    // Values read straight from the payload property; the toggle folds ON/OFF.
    const patch = applyStateRules(descriptor, { mode: 'b', lock: 'ON', probe: 21 }).get(1)!;
    expect(patch.custom?.values).toEqual({ mode: 'b', lock: true, probe: 21 });
    // Writes go out on the field's property; toggles translate back.
    expect(buildCommandPayload(descriptor, 1, { type: 'setCustomField', fieldId: 'mode', value: 'a' })).toEqual({
      mode: 'a',
    });
    expect(buildCommandPayload(descriptor, 1, { type: 'setCustomField', fieldId: 'lock', value: false })).toEqual({
      lock: 'OFF',
    });
    // Read-only field → null (the adapter then rejects it).
    expect(buildCommandPayload(descriptor, 1, { type: 'setCustomField', fieldId: 'probe', value: 1 })).toBeNull();
  });

  it('maps a non-standard IR blaster through irRemote paths and commands', () => {
    const descriptor: MappingDescriptor = {
      version: 1,
      endpoints: [
        {
          endpointId: 1,
          deviceKind: 'remote',
          capabilities: ['irRemote'],
          primary: 'irRemote',
          stateRules: [{ property: 'rf_learned', to: 'irRemote.pendingCode' }],
          commandRules: [
            {
              intent: 'irLearn',
              property: 'rf_learn',
              transform: { kind: 'boolMap', whenTrue: 'START', whenFalse: 'STOP' },
            },
            { intent: 'irSendRaw', property: 'rf_send' },
          ],
        },
      ],
    };
    expect(sanityCheckDescriptor(descriptor)).toEqual([]);
    const patch = applyStateRules(descriptor, { rf_learned: 'BLOB==' }).get(1)!;
    expect(patch.irRemote).toMatchObject({ pendingCode: 'BLOB==', learning: false });
    expect(buildCommandPayload(descriptor, 1, { type: 'irLearn', on: true })).toEqual({ rf_learn: 'START' });
    expect(buildCommandPayload(descriptor, 1, { type: 'irSendRaw', code: 'BLOB==' })).toEqual({ rf_send: 'BLOB==' });
  });

  it('builds command payloads with reversed transforms', () => {
    expect(buildCommandPayload(dimmerDescriptor, 1, { type: 'power', on: true })).toEqual({ state: 'ON' });
    expect(buildCommandPayload(dimmerDescriptor, 1, { type: 'setLevel', level: 254 })).toEqual({
      dim_level: 1000,
    });
    // No rule for this intent → null (caller falls back / rejects).
    expect(buildCommandPayload(dimmerDescriptor, 1, { type: 'stopCovering' })).toBeNull();
  });

  it('reverses enumMap for command intents', () => {
    const descriptor: MappingDescriptor = {
      version: 1,
      endpoints: [
        {
          endpointId: 1,
          deviceKind: 'climate',
          capabilities: ['thermostat'],
          primary: 'thermostat',
          stateRules: [
            { property: 'mode', to: 'thermostat.systemMode', transform: { kind: 'enumMap', map: { off: 0, heat: 4 } } },
          ],
          commandRules: [
            { intent: 'setSystemMode', property: 'mode', transform: { kind: 'enumMap', map: { off: 0, heat: 4 } } },
          ],
        },
      ],
    };
    expect(buildCommandPayload(descriptor, 1, { type: 'setSystemMode', mode: 4 })).toEqual({ mode: 'heat' });
  });
});

// ── Mapper caching against Postgres ────────────────────────────────────────

const handle = await openTestDb();

const soilProbe: Z2mDevice = {
  ieee_address: '0xa4c138999999999',
  friendly_name: 'Mystery soil probe',
  supported: true,
  definition: {
    vendor: 'Tuya',
    model: 'TS0601_soil',
    exposes: [
      { type: 'numeric', name: 'soil_moisture', property: 'soil_moisture', access: 1, unit: '%' },
      { type: 'numeric', name: 'temperature', property: 'temperature', access: 1, unit: '°C' },
    ],
  },
};

const soilDescriptor: MappingDescriptor = {
  version: 1,
  endpoints: [
    {
      endpointId: 1,
      deviceKind: 'sensor',
      capabilities: ['humidity', 'temperature'],
      primary: 'humidity',
      stateRules: [
        { property: 'soil_moisture', to: 'sensors.humidityCenti', transform: { kind: 'multiply', factor: 100 } },
        { property: 'temperature', to: 'sensors.temperatureCenti', transform: { kind: 'celsiusToCenti' } },
      ],
      commandRules: [],
    },
  ],
};

describe.skipIf(!handle)('AiDeviceMapper', () => {
  // Skipped suites still have their body collected, so never deref a null
  // handle here; `db` is only read once the suite actually runs.
  const db = handle?.db!;
  const dataDir = mkdtempSync(path.join(tmpdir(), 'gethome-ai-test-'));
  let mapper: AiDeviceMapper;
  let settingsService: SettingsService;
  let generate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await resetDb(db);
    settingsService = new SettingsService(db, Buffer.alloc(32).toString('base64'));
    mapper = new AiDeviceMapper(db, settingsService, pino({ level: 'silent' }));
    generate = vi.fn().mockResolvedValue(soilDescriptor);
    mapper.providerOverride = { generate };
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('generates, validates, applies, and caches a mapping', async () => {
    const applied = await mapper.requestMapping(soilProbe, mapExposes(soilProbe));
    expect(applied).not.toBeNull();
    expect(generate).toHaveBeenCalledTimes(1);
    const patch = applied!.extractState({ soil_moisture: 42, temperature: 19.5 }).get(1)!;
    expect(patch.sensors?.humidityCenti).toBe(4200);
    expect(patch.sensors?.temperatureCenti).toBe(1950);
    // The adapter uses this to tell known payload keys from new parameters.
    expect(applied!.properties).toEqual(new Set(['soil_moisture', 'temperature']));

    // Second sighting of the same model hits the cache, not the provider.
    const again = await mapper.requestMapping(soilProbe, mapExposes(soilProbe));
    expect(again).not.toBeNull();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('force-regenerates past the cache and feeds samples into the prompt', async () => {
    await mapper.requestMapping(soilProbe, mapExposes(soilProbe));
    expect(generate).toHaveBeenCalledTimes(1);
    const samples = [{ soil_moisture: 42, mystery_field: 7 }];
    const applied = await mapper.requestMapping(soilProbe, mapExposes(soilProbe), {
      samples,
      force: true,
    });
    expect(applied).not.toBeNull();
    expect(generate).toHaveBeenCalledTimes(2);
    const prompt = generate.mock.calls[1]![1] as string;
    expect(prompt).toContain('mystery_field');
  });

  it('rejects invalid model output and caches the rejection', async () => {
    generate.mockResolvedValue({ version: 1, endpoints: [] });
    expect(await mapper.requestMapping(soilProbe, mapExposes(soilProbe))).toBeNull();
    // Rejection is cached: no second provider call.
    expect(await mapper.requestMapping(soilProbe, mapExposes(soilProbe))).toBeNull();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('rejects descriptors that fail sanity checks', async () => {
    generate.mockResolvedValue({
      version: 1,
      endpoints: [
        {
          endpointId: 1,
          deviceKind: 'sensor',
          capabilities: ['temperature'],
          primary: 'humidity',
          stateRules: [],
          commandRules: [],
        },
      ],
    });
    expect(await mapper.requestMapping(soilProbe, mapExposes(soilProbe))).toBeNull();
  });

  it('does nothing without a configured provider', async () => {
    mapper.providerOverride = null;
    expect(await mapper.requestMapping(soilProbe, mapExposes(soilProbe))).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it('invalidate() clears the cache so the provider is asked again', async () => {
    await mapper.requestMapping(soilProbe, mapExposes(soilProbe));
    await mapper.invalidate(soilProbe);
    await mapper.requestMapping(soilProbe, mapExposes(soilProbe));
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('hashes by schema, not by name', () => {
    const renamed = { ...soilProbe, friendly_name: 'Другой датчик' };
    expect(exposesHash(renamed)).toBe(exposesHash(soilProbe));
    const differentSchema = {
      ...soilProbe,
      definition: { ...soilProbe.definition!, exposes: [] },
    };
    expect(exposesHash(differentSchema)).not.toBe(exposesHash(soilProbe));
  });

  it('shares one in-flight run per device model', async () => {
    generate.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return soilDescriptor;
    });
    const [first, second] = await Promise.all([
      mapper.requestMapping(soilProbe, mapExposes(soilProbe)),
      mapper.requestMapping(soilProbe, mapExposes(soilProbe)),
    ]);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('backs off after a transient availability failure and recovers', async () => {
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      generate.mockRejectedValue(new AiUnavailableError('rate_limited', '429 rate limit'));
      expect(await mapper.requestMapping(soilProbe, mapExposes(soilProbe))).toBeNull();
      expect(generate).toHaveBeenCalledTimes(1);

      // The failure is NOT cached — it is the backoff gate that suppresses
      // the retry, so the account isn't hammered while it is down.
      expect(await mapper.requestMapping(soilProbe, mapExposes(soilProbe))).toBeNull();
      expect(generate).toHaveBeenCalledTimes(1);
      const during = await settingsService.getAiStatus();
      expect(during.lastError?.kind).toBe('rate_limited');

      // Past the first backoff step the mapper tries again; success clears
      // the gate and the surfaced error.
      nowSpy.mockReturnValue(realNow + 61_000);
      generate.mockResolvedValue(soilDescriptor);
      expect(await mapper.requestMapping(soilProbe, mapExposes(soilProbe))).not.toBeNull();
      const after = await settingsService.getAiStatus();
      expect(after.lastError).toBeUndefined();
      expect(after.lastRun?.ok).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('honours a provider-supplied reset time over the backoff ladder', async () => {
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      generate.mockRejectedValue(
        new AiUnavailableError('usage_limit', 'weekly limit reached', new Date(realNow + 3_600_000)),
      );
      expect(await mapper.requestMapping(soilProbe, mapExposes(soilProbe))).toBeNull();
      const status = await settingsService.getAiStatus();
      expect(status.lastError?.kind).toBe('usage_limit');
      expect(status.lastError?.resetAt).toBeDefined();

      // Ten minutes later (past the 60s ladder step) it is still gated,
      // because the provider said the window resets in an hour.
      nowSpy.mockReturnValue(realNow + 600_000);
      expect(await mapper.requestMapping(soilProbe, mapExposes(soilProbe))).toBeNull();
      expect(generate).toHaveBeenCalledTimes(1);

      nowSpy.mockReturnValue(realNow + 3_600_001);
      generate.mockResolvedValue(soilDescriptor);
      expect(await mapper.requestMapping(soilProbe, mapExposes(soilProbe))).not.toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });
});
