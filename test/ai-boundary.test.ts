import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { SettingsService } from '../src/core/settings.js';
import { AiDeviceMapper, notDeviceShaped } from '../src/ai/mapper.js';
import { lazyAiAssist } from '../src/ai/lazy.js';
import { mappingSystemPrompt } from '../src/ai/prompts.js';
import { mapExposes, type Z2mDevice } from '../src/adapters/zigbee/exposes-mapper.js';
import { openTestDb, resetDb } from './helpers/db.js';

const handle = await openTestDb();
const log = pino({ level: 'silent' });

/** A real device, minimal but complete: an address and a published schema. */
const lamp: Z2mDevice = {
  ieee_address: '0x00158d0001abcdef',
  friendly_name: 'porch lamp',
  definition: {
    vendor: 'Acme',
    model: 'AC-LAMP-1',
    exposes: [
      {
        type: 'light',
        features: [{ type: 'binary', name: 'state', property: 'state', access: 7, value_on: 'ON', value_off: 'OFF' }],
      },
      // Something the static mapper cannot place, so a mapping is wanted.
      { type: 'numeric', name: 'mystery_knob', property: 'mystery_knob', access: 1 },
    ],
  },
} as Z2mDevice;

const descriptor = {
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

describe.skipIf(!handle)('the boundary around the mapping agent', () => {
  const db = handle?.db!;
  let settings: SettingsService;

  beforeEach(async () => {
    await resetDb(db);
    settings = new SettingsService(db, Buffer.alloc(32).toString('base64'));
  });

  afterAll(async () => {
    await handle?.close();
  });

  describe('what counts as a device', () => {
    it('accepts a device with an address and a published schema', () => {
      expect(notDeviceShaped(lamp)).toBeNull();
    });

    it('refuses hub traffic dressed up as a device', () => {
      // The shape a bridge message would have if something ever routed one
      // here: a name, a payload, and nothing that identifies a radio device.
      expect(notDeviceShaped({ friendly_name: 'bridge/info' } as Z2mDevice)).toMatch(/IEEE address/i);
      expect(
        notDeviceShaped({
          ieee_address: '0xabc',
          friendly_name: 'bridge/request/permit_join',
          definition: { exposes: [{ type: 'numeric', name: 'time', property: 'time' }] },
        } as Z2mDevice),
      ).toMatch(/bridge topic/i);
    });

    it('refuses a device with nothing to map', () => {
      expect(
        notDeviceShaped({ ieee_address: '0xabc', friendly_name: 'x', definition: { exposes: [] } } as Z2mDevice),
      ).toMatch(/no published schema/i);
    });

    it('refuses the coordinator, which is the radio and not a device', () => {
      expect(notDeviceShaped({ ...lamp, type: 'Coordinator' } as Z2mDevice)).toMatch(/coordinator/i);
    });

    it('refuses nothing at all', () => {
      expect(notDeviceShaped(null)).not.toBeNull();
      expect(notDeviceShaped(undefined)).not.toBeNull();
    });
  });

  it('never reaches the provider for something that is not a device', async () => {
    const mapper = new AiDeviceMapper(db, settings, log);
    const generate = vi.fn().mockResolvedValue(descriptor);
    mapper.providerOverride = { generate };

    const notADevice = { friendly_name: 'bridge/logging' } as Z2mDevice;
    const result = await mapper.requestMapping(notADevice, mapExposes(lamp));

    expect(result).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  // Both providers, because the prompt is built per provider now — the
  // research paragraph differs, and a wall that only one vendor's run is told
  // about is a wall with a door in it.
  it.each(['anthropic', 'openai'] as const)(
    'tells a %s run, in the prompt, that its input is only ever a device',
    (provider) => {
      // The guard above is the wall; this is the instruction, and a run that
      // somehow receives something else must refuse rather than invent.
      expect(mappingSystemPrompt(provider)).toMatch(/one physical device's published schema/i);
      expect(mappingSystemPrompt(provider)).toMatch(/never a bridge message/i);
    },
  );

  /**
   * The research paragraph names tools, and the two runs do not have the same
   * ones: Anthropic carries `web_fetch`, OpenAI deliberately does not. One
   * shared prompt told an OpenAI run to fetch the device's page first and then
   * not to spend searches confirming it — three instructions about a tool it
   * hasn't got, at the point in the run where research is decided.
   */
  it('never tells a run to use a tool that provider’s loop does not carry', () => {
    expect(mappingSystemPrompt('anthropic')).toMatch(/web_fetch/);
    expect(mappingSystemPrompt('openai')).not.toMatch(/web_fetch/);
    // Both still have search, and both are still pointed at the same page.
    expect(mappingSystemPrompt('openai')).toMatch(/web_search/);
    expect(mappingSystemPrompt('openai')).toMatch(/zigbee2mqtt\.io/i);
  });

  describe('the owner’s switch', () => {
    it('runs nothing while adaptation is switched off, key or no key', async () => {
      await settings.setAiSettings({ model: null, apiKey: 'sk-ant-api-test-key-1234' });
      await settings.setAiEnabled(false);

      const assist = lazyAiAssist({ db, settings, log });
      expect(await assist.requestMapping(lamp, mapExposes(lamp))).toBeNull();
    });

    it('keeps the credential when it is switched off', async () => {
      await settings.setAiSettings({ model: null, apiKey: 'sk-ant-api-test-key-1234' });
      await settings.setAiEnabled(false);

      const stored = await settings.getAiSettings();
      expect(stored.hasKey).toBe(true);
      expect(stored.enabled).toBe(false);
    });

    it('is on by default, so a hub configured before it existed is unchanged', async () => {
      await settings.setAiSettings({ model: null, apiKey: 'sk-ant-api-test-key-1234' });
      expect((await settings.getAiSettings()).enabled).toBe(true);
    });

    it('runs nothing without a key, switched on or not', async () => {
      const assist = lazyAiAssist({ db, settings, log });
      expect(await assist.requestMapping(lamp, mapExposes(lamp))).toBeNull();
    });

    it('is refused even when the mapper is reached directly', async () => {
      await settings.setAiSettings({ model: null, apiKey: 'sk-ant-api-test-key-1234' });
      await settings.setAiEnabled(false);

      // No providerOverride: resolveProvider is the gate being tested, and it
      // has to hold for a mapper somebody constructed themselves.
      const mapper = new AiDeviceMapper(db, settings, log);
      expect(await mapper.requestMapping(lamp, mapExposes(lamp))).toBeNull();
    });

    it('comes back on when the credential is replaced', async () => {
      await settings.setAiSettings({ model: null, apiKey: 'sk-ant-api-test-key-1234' });
      await settings.setAiEnabled(false);
      await settings.clearAiSettings();
      await settings.setAiSettings({ model: null, apiKey: 'sk-ant-api-test-key-5678' });

      expect((await settings.getAiSettings()).enabled).toBe(true);
    });
  });
});
