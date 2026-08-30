import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { SettingsService } from '../src/core/settings.js';
import { AiDeviceMapper } from '../src/ai/mapper.js';
import { AiUnavailableError, describeRunFailure, readableFailure } from '../src/ai/errors.js';
import { mapExposes, type Z2mDevice } from '../src/adapters/zigbee/exposes-mapper.js';
import { openTestDb, resetDb } from './helpers/db.js';

/**
 * Trying again after changing something.
 *
 * Recognition fails for reasons a person can fix — a key that is wrong, a key
 * that names no workspace, a model too weak to produce a valid descriptor —
 * and every one of those fixes is followed by the same move: come back and
 * press the button. These are the rules that make that move do something.
 */

const handle = await openTestDb();
const log = pino({ level: 'silent' });

/** An address, a published schema, and one property nothing static can place. */
const lamp: Z2mDevice = {
  ieee_address: '0x00158d0001abcdef',
  friendly_name: 'porch lamp',
  definition: {
    vendor: 'Acme',
    model: 'AC-LAMP-1',
    exposes: [
      {
        type: 'light',
        features: [
          { type: 'binary', name: 'state', property: 'state', access: 7, value_on: 'ON', value_off: 'OFF' },
        ],
      },
      { type: 'numeric', name: 'mystery_knob', property: 'mystery_knob', access: 1 },
    ],
  },
} as Z2mDevice;

/** A second model, so a run for it cannot join the lamp's in-flight run. */
const sensor: Z2mDevice = {
  ieee_address: '0x00158d0002fedcba',
  friendly_name: 'hall sensor',
  definition: {
    vendor: 'Acme',
    model: 'AC-SENSE-2',
    exposes: [{ type: 'numeric', name: 'odd_reading', property: 'odd_reading', access: 1 }],
  },
} as Z2mDevice;

/** What the Anthropic SDK actually throws when a key names no workspace. */
const WORKSPACE_400 =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"anthropic-workspace-id ' +
  'is required when authenticating with an identity-linked API key; send the id of the workspace ' +
  'this request acts in."},"request_id":null}';

describe('what a failed run is recorded as', () => {
  it('digs the provider’s own sentence out of its response body', () => {
    const { message } = describeRunFailure(new Error(WORKSPACE_400));
    expect(message).toContain('anthropic-workspace-id is required');
    // The envelope is what made this unreadable on a device row: three
    // quarters of the string was punctuation.
    expect(message).not.toContain('"type":"error"');
    expect(message).not.toContain('request_id');
  });

  it('names the fix for a refusal that is really a setting', () => {
    const { kind, message } = describeRunFailure(new Error(WORKSPACE_400));
    expect(kind).toBe('config');
    expect(message).toMatch(/scoped to one workspace/i);
  });

  it('still reports a failure it has never seen, without inventing a cause', () => {
    const { kind, message } = describeRunFailure(new Error('the agent gave up after 40 turns'));
    expect(kind).toBe('run_failed');
    expect(message).toBe('the agent gave up after 40 turns');
  });

  it('leaves a message that is already prose alone', () => {
    expect(readableFailure(new Error('socket hang up'))).toBe('socket hang up');
    // Something JSON-shaped but not a provider error must survive too — a
    // wrong guess here would replace the only evidence there is.
    expect(readableFailure(new Error('failed to parse {"a":1}'))).toBe('failed to parse {"a":1}');
  });
});

describe.skipIf(!handle)('trying again after the settings change', () => {
  const db = handle?.db!;
  let settings: SettingsService;

  beforeEach(async () => {
    await resetDb(db);
    settings = new SettingsService(db, Buffer.alloc(32).toString('base64'));
    await settings.setAiSettings({ model: null, apiKey: 'sk-ant-api-first-key-0000' });
  });

  afterAll(async () => {
    await handle?.close();
  });

  /** A mapper whose agent always fails the account, and the run counter. */
  const failingMapper = (error: Error) => {
    const generate = vi.fn().mockRejectedValue(error);
    const mapper = new AiDeviceMapper(db, settings, log);
    mapper.providerOverride = { generate };
    return { mapper, generate };
  };

  it('stops asking automatically once the account has refused', async () => {
    const { mapper, generate } = failingMapper(
      new AiUnavailableError('auth_failed', '401 invalid x-api-key'),
    );

    await mapper.requestMapping(lamp, mapExposes(lamp));
    await mapper.requestMapping(lamp, mapExposes(lamp));

    // The second announcement never reached the agent: that is the whole
    // point of the gate, and it costs nothing to hold.
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('tries again by itself once the key has been replaced', async () => {
    const { mapper, generate } = failingMapper(
      new AiUnavailableError('auth_failed', '401 invalid x-api-key'),
    );
    await mapper.requestMapping(lamp, mapExposes(lamp));

    await settings.setAiKey('anthropic', 'sk-ant-api-second-key-1111');
    await mapper.requestMapping(lamp, mapExposes(lamp));

    // The gate was armed against a credential this hub no longer has, so the
    // judgement behind it is stale — the owner has just done the one thing
    // that could fix it and must not wait out a two-hour timer.
    expect(generate).toHaveBeenCalledTimes(2);
  });

  /**
   * The gate is keyed on `provider:model:sha256(secret)`, and the model half
   * of that is no longer something anybody can move: each provider offers one
   * model, so a stored setting naming a retired one resolves to what is
   * actually offered (`effectiveModel`). The axis stays in the key for the day
   * a second model is offered again; what has to hold *now* is that the gate
   * is keyed on the model that will really run, not on the string in the
   * column — otherwise a hub carrying a stale `claude-sonnet-5` would key its
   * gate on a model no run will ever use, and the two would drift the moment
   * anything compared them.
   */
  it('keys the gate on the model that will run, not on a retired stored one', async () => {
    const { mapper, generate } = failingMapper(
      new AiUnavailableError('rate_limited', '429 too many requests'),
    );
    await mapper.requestMapping(lamp, mapExposes(lamp));

    // Sonnet is priced, so the setter takes it; it is not offered, so nothing
    // about the run changes — and neither does the gate.
    await settings.setAiModel('claude-sonnet-5', 'anthropic');
    await mapper.requestMapping(lamp, mapExposes(lamp));

    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('does not let one provider’s failure silence the other', async () => {
    const { mapper, generate } = failingMapper(
      new AiUnavailableError('billing', 'credit balance is too low'),
    );
    await mapper.requestMapping(lamp, mapExposes(lamp));

    // Saving the second key and switching to it is exactly what an app tells
    // somebody to do when the first one is out of credit.
    await settings.setAiKey('openai', 'sk-openai-test-key-2222');
    await settings.setMappingProvider('openai');
    await mapper.requestMapping(lamp, mapExposes(lamp));

    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('runs an explicit ask even while the gate is armed', async () => {
    const { mapper, generate } = failingMapper(
      new AiUnavailableError('rate_limited', '429 too many requests'),
    );
    await mapper.requestMapping(lamp, mapExposes(lamp));

    // Nothing has changed but somebody pressed the button. A person asking
    // now is the one caller the gate must never answer with silence, because
    // silence is indistinguishable from a button that does nothing.
    await mapper.requestMapping(lamp, mapExposes(lamp), { force: true });

    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('runs an explicit ask that is queued behind a run which arms the gate', async () => {
    const { mapper, generate } = failingMapper(
      new AiUnavailableError('rate_limited', '429 too many requests'),
    );

    // Two *different* models, so neither joins the other's in-flight run and
    // the queue really does put one behind the other. Both are asked for
    // before either has finished, so the forced one is behind a run that has
    // not armed the gate yet — clearing the gate where the button is pressed
    // would let that run re-arm it in the gap.
    const automatic = mapper.requestMapping(lamp, mapExposes(lamp));
    const explicit = mapper.requestMapping(sensor, mapExposes(sensor), { force: true });
    await Promise.all([automatic, explicit]);

    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('joins an explicit ask to a run already under way for the same model', async () => {
    // The other side of the rule above, and the reason it is worth stating:
    // one model is one run, because each run costs real money and a second
    // device of a model gets the first one's answer for nothing.
    const { mapper, generate } = failingMapper(
      new AiUnavailableError('rate_limited', '429 too many requests'),
    );

    await Promise.all([
      mapper.requestMapping(lamp, mapExposes(lamp)),
      mapper.requestMapping(lamp, mapExposes(lamp), { force: true }),
    ]);

    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('backs off further each time, rather than restarting the ladder', async () => {
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      const { mapper, generate } = failingMapper(
        new AiUnavailableError('rate_limited', '429 too many requests'),
      );

      // First failure: the ladder's first step is a minute.
      await mapper.requestMapping(lamp, mapExposes(lamp));
      nowSpy.mockReturnValue(realNow + 61_000);

      // Second failure, past that step. The next one has to be *five* minutes:
      // the count behind the ladder must survive the gate expiring, or a hub
      // whose account is dead retries every sixty seconds for ever.
      await mapper.requestMapping(lamp, mapExposes(lamp));
      expect(generate).toHaveBeenCalledTimes(2);

      nowSpy.mockReturnValue(realNow + 61_000 + 61_000);
      await mapper.requestMapping(lamp, mapExposes(lamp));
      expect(generate).toHaveBeenCalledTimes(2);

      nowSpy.mockReturnValue(realNow + 61_000 + 301_000);
      await mapper.requestMapping(lamp, mapExposes(lamp));
      expect(generate).toHaveBeenCalledTimes(3);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('starts the ladder again for a credential the failures were not about', async () => {
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      const { mapper, generate } = failingMapper(
        new AiUnavailableError('auth_failed', '401 invalid x-api-key'),
      );
      await mapper.requestMapping(lamp, mapExposes(lamp));
      nowSpy.mockReturnValue(realNow + 61_000);
      await mapper.requestMapping(lamp, mapExposes(lamp));
      expect(generate).toHaveBeenCalledTimes(2);

      // A different key has a different history, so the second failure above
      // must not cost it the five-minute step.
      await settings.setAiKey('anthropic', 'sk-ant-api-second-key-1111');
      nowSpy.mockReturnValue(realNow + 61_000 + 61_000);
      await mapper.requestMapping(lamp, mapExposes(lamp));
      expect(generate).toHaveBeenCalledTimes(3);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('forgets the gate as soon as a run gets through', async () => {
    const generate = vi
      .fn()
      .mockRejectedValueOnce(new AiUnavailableError('overloaded', '529 overloaded'))
      .mockRejectedValueOnce(new Error('the agent gave up'));
    const mapper = new AiDeviceMapper(db, settings, log);
    mapper.providerOverride = { generate };

    await mapper.requestMapping(lamp, mapExposes(lamp));
    await mapper.requestMapping(lamp, mapExposes(lamp), { force: true });
    // The forced run reached the account, so the account works: the next
    // automatic announcement is not gated either.
    await mapper.requestMapping(lamp, mapExposes(lamp));

    expect(generate).toHaveBeenCalledTimes(3);
  });

  it('asks again for a model whose descriptor was rejected', async () => {
    // A weaker model can leave a `rejected` row, which every later
    // announcement reads as a settled answer. Changing the model is how
    // somebody says "try that again", so the explicit ask must drop it.
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ version: 1, endpoints: [] })
      .mockRejectedValueOnce(new Error('second run'));
    const mapper = new AiDeviceMapper(db, settings, log);
    mapper.providerOverride = { generate };

    await mapper.requestMapping(lamp, mapExposes(lamp));
    expect(await mapper.requestMapping(lamp, mapExposes(lamp))).toBeNull();
    expect(generate).toHaveBeenCalledTimes(1);

    await mapper.requestMapping(lamp, mapExposes(lamp), { force: true });
    expect(generate).toHaveBeenCalledTimes(2);
  });
});
