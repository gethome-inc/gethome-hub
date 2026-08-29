import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { SettingsService } from '../src/core/settings.js';
import { AiRunLog } from '../src/core/ai-runs.js';
import { AiDeviceMapper } from '../src/ai/mapper.js';
import {
  MAX_EXCHANGE_PARTS,
  MAX_EXCHANGE_TEXT,
  agentExchange,
  describeThrown,
  exchangePart,
  record,
  type AgentRunContext,
} from '../src/ai/agent-core.js';
import { HubEventBus } from '../src/core/bus.js';
import { aiRuns as aiRunsTable } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { mapExposes, type Z2mDevice } from '../src/adapters/zigbee/exposes-mapper.js';
import { openTestDb, resetDb } from './helpers/db.js';

/**
 * What a run actually said to a provider.
 *
 * The run log is a summary by design — model prose on an SD card is the write
 * amplification the rest of the store is arranged to avoid — so this is the
 * exception, and what these tests pin is the three things that make an
 * exception affordable: it is off unless somebody asked, it records a round's
 * main data rather than its bodies, and it can never be what ends a run.
 */

const handle = await openTestDb();
const log = pino({ level: 'silent' });

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

describe('one round, written down', () => {
  it('cuts a long part and says what it weighed whole', () => {
    const part = exchangePart('system', 'System prompt', 'x'.repeat(MAX_EXCHANGE_TEXT + 500));
    expect(part.text).toHaveLength(MAX_EXCHANGE_TEXT);
    // The app writes "kept 4 KB of 4.5 KB" from this rather than asserting a
    // constant out of the hub's source.
    expect(part.bytes).toBe(MAX_EXCHANGE_TEXT + 500);
  });

  it('leaves a part that fits without a size, so nothing claims a cut', () => {
    expect(exchangePart('text', 'Answered in prose', 'short').bytes).toBeUndefined();
  });

  it('counts bytes rather than characters, and cuts on a character', () => {
    // `String.length` is UTF-16 units, so a Cyrillic payload under-reports by
    // half — and `subarray().toString()` would split the last two-byte
    // sequence and leave U+FFFD behind.
    const part = exchangePart('message', 'user', 'я'.repeat(MAX_EXCHANGE_TEXT));
    expect(part.bytes).toBe(MAX_EXCHANGE_TEXT * 2);
    expect(part.text).not.toContain('�');
  });

  it('records something for a value it cannot serialise', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    // An empty box would read as "nothing was sent", which is a different and
    // much worse claim than "this could not be written down".
    expect(exchangePart('message', 'user', circular).text).toMatch(/could not be recorded/i);
  });

  it('keeps a refusal’s status, message and body, and no headers', () => {
    const parts = describeThrown({
      name: 'BadRequestError',
      status: 400,
      message: '400 {"type":"error"}',
      error: { type: 'invalid_request_error', message: 'anthropic-workspace-id is required' },
      headers: { 'x-api-key': 'sk-ant-secret' },
    });
    const flat = JSON.stringify(parts);
    expect(flat).toContain('anthropic-workspace-id');
    expect(parts[0]?.label).toBe('Refused with 400');
    // Headers are where a credential would be, so they are never walked.
    expect(flat).not.toContain('sk-ant-secret');
    expect(flat).not.toContain('x-api-key');
  });

  it('caps how many parts one round keeps', () => {
    const many = Array.from({ length: MAX_EXCHANGE_PARTS + 10 }, (_, index) =>
      exchangePart('text', `part ${index}`),
    );
    const exchange = agentExchange({
      seq: 1,
      startedAt: Date.now(),
      provider: 'anthropic',
      modelId: 'claude-opus-5',
      ok: true,
      sent: many,
      received: many,
    });
    expect(exchange.sent).toHaveLength(MAX_EXCHANGE_PARTS);
    expect(exchange.received).toHaveLength(MAX_EXCHANGE_PARTS);
  });
});

describe('recording never costs the run', () => {
  it('does no work at all when nobody is recording', () => {
    const build = vi.fn(() => ({
      seq: 1,
      startedAt: Date.now(),
      provider: 'anthropic',
      modelId: 'claude-opus-5',
      ok: true,
      sent: [],
      received: [],
    }));
    // The absence of the callback *is* the off switch, so the thunk must not
    // even run — walking a vendor's content blocks is the expensive half.
    record({}, build);
    record(undefined, build);
    expect(build).not.toHaveBeenCalled();
  });

  it('swallows a recorder that throws, because recognising the device is the job', () => {
    const run: AgentRunContext = {
      onExchange: () => {
        throw new Error('the log is broken');
      },
    };
    expect(() =>
      record(run, () => ({
        seq: 1,
        startedAt: Date.now(),
        provider: 'anthropic',
        modelId: 'claude-opus-5',
        ok: true,
        sent: [],
        received: [],
      })),
    ).not.toThrow();
  });

  it('swallows a distiller that throws on a shape nobody anticipated', () => {
    const seen: unknown[] = [];
    expect(() =>
      record({ onExchange: (exchange) => seen.push(exchange) }, () => {
        throw new Error('an unexpected content block');
      }),
    ).not.toThrow();
    expect(seen).toEqual([]);
  });
});

describe.skipIf(!handle)('what a run keeps', () => {
  const db = handle?.db!;
  let settings: SettingsService;
  let runs: AiRunLog;

  beforeEach(async () => {
    await resetDb(db);
    settings = new SettingsService(db, Buffer.alloc(32).toString('base64'));
    await settings.setAiSettings({ model: null, apiKey: 'sk-ant-api-test-key-1234' });
    runs = new AiRunLog(db, new HubEventBus());
  });

  afterAll(async () => {
    await handle?.close();
  });

  /** A mapper whose agent reports one round and then gives up. */
  const mapperReportingOneRound = () => {
    const mapper = new AiDeviceMapper(db, settings, log, runs);
    mapper.providerOverride = {
      generate: async (_system, _user, run) => {
        record(run, () => ({
          seq: 1,
          startedAt: Date.now(),
          provider: 'anthropic',
          modelId: 'claude-opus-5',
          status: 400,
          ok: false,
          sent: [exchangePart('system', 'System prompt', 'you are a mapper')],
          received: [exchangePart('error', 'Refused with 400', 'workspace id required')],
        }));
        throw new Error('the run gave up');
      },
    };
    return mapper;
  };

  it('keeps nothing until the owner asks for it', async () => {
    await mapperReportingOneRound().requestMapping(lamp, mapExposes(lamp));

    const [row] = await runs.list();
    expect(row).toBeDefined();
    // The run itself is always recorded — it is the summary that costs
    // nothing. What it said is not.
    expect(await runs.exchangesOf(row!.id)).toEqual([]);
  });

  it('keeps the round once recording is on, with its provider and model', async () => {
    await settings.setAiRecordExchanges(true);
    await mapperReportingOneRound().requestMapping(lamp, mapExposes(lamp));

    const [row] = await runs.list();
    const rounds = await runs.exchangesOf(row!.id);
    expect(rounds).toHaveLength(1);
    // Recorded per round rather than per run, because a run can be retried
    // against another provider entirely.
    expect(rounds[0]).toMatchObject({
      seq: 1,
      provider: 'anthropic',
      modelId: 'claude-opus-5',
      status: 400,
      ok: false,
    });
    expect(JSON.stringify(rounds[0]?.received)).toContain('workspace id required');
  });

  it('answers how many rounds a run kept, so a list need not fetch them', async () => {
    await settings.setAiRecordExchanges(true);
    await mapperReportingOneRound().requestMapping(lamp, mapExposes(lamp));

    const [row] = await runs.list();
    expect((await runs.exchangeCounts([row!.id])).get(row!.id)).toBe(1);
    expect((await runs.exchangeCounts([])).size).toBe(0);
  });

  it('reads a failed attempt and the one after it in the order they happened', async () => {
    await settings.setAiRecordExchanges(true);
    const mapper = new AiDeviceMapper(db, settings, log, runs);
    mapper.providerOverride = {
      generate: async (_system, _user, run) => {
        for (const seq of [1, 2]) {
          record(run, () => ({
            seq,
            startedAt: Date.now(),
            provider: 'anthropic',
            modelId: 'claude-opus-5',
            ok: seq === 2,
            sent: [exchangePart('message', 'user', `round ${seq}`)],
            received: [exchangePart('outcome', seq === 2 ? 'Stopped: tool_use' : 'Refused with 429')],
          }));
        }
        throw new Error('the run gave up');
      },
    };
    await mapper.requestMapping(lamp, mapExposes(lamp));

    const [row] = await runs.list();
    const rounds = await runs.exchangesOf(row!.id);
    // Oldest first: the point of keeping both is reading what changed between
    // the one that failed and the one that did not.
    expect(rounds.map((round) => round.seq)).toEqual([1, 2]);
    expect(rounds.map((round) => round.ok)).toEqual([false, true]);
  });

  it('takes a run’s rounds with it when the run is pruned', async () => {
    await settings.setAiRecordExchanges(true);
    await mapperReportingOneRound().requestMapping(lamp, mapExposes(lamp));
    const [row] = await runs.list();

    await db.delete(aiRunsTable).where(eq(aiRunsTable.id, row!.id));

    expect(await runs.exchangesOf(row!.id)).toEqual([]);
  });
});

