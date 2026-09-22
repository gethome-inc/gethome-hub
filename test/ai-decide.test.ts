import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../src/logging.js';
import { DECISION_MODEL } from '../src/ai/decide/decider.js';
import {
  MAX_STATE_CHARS,
  estimateDecisionCostUsd,
  runDecision,
} from '../src/ai/decide/typesafe.js';
import { lazyDecider } from '../src/ai/decide/lazy.js';
import type { SettingsService } from '../src/core/settings.js';

/**
 * The wire to a decision model, which is the one thing here nobody can check
 * by running the hub.
 *
 * `fetch` is stubbed with **real `Response` objects** rather than parsed
 * bodies, for the reason `test/ai-openai-chat.test.ts` learned the hard way: a
 * mock laxer than the thing it stands in for tests the mock. Every case below
 * is either something the vendor can send that the hub has to survive, or
 * something the hub must never send.
 */

const log = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Stub `fetch`, recording exactly what was sent. */
function stub(responder: (call: Call) => Response): { calls: Call[] } {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    (async (input: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const call: Call = {
        url: String(input),
        headers,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      calls.push(call);
      return responder(call);
    }) as unknown as typeof fetch,
  );
  return { calls };
}

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-typesafe-request-id': 'req-42' },
  });

const questions = {
  urgent: { type: 'noul', instructions: 'It needs doing now.' },
  where: {
    type: 'choice',
    instructions: 'Which room?',
    criteria: { kitchen: 'The kitchen.', hall: 'The hall.' },
  },
  severity: {
    type: 'score',
    instructions: 'How bad is it?',
    criteria: ['Fine.', 'Awkward.', 'Broken.'],
  },
} as const;

const answered = {
  model: DECISION_MODEL,
  answers: {
    urgent: { type: 'noul', noul: 0.91 },
    where: {
      type: 'choice',
      choice: 'kitchen',
      probabilities: { kitchen: 0.97, hall: 0.03 },
      confidence: 0.96,
    },
    severity: {
      type: 'score',
      score: 1.4,
      probabilities: { '0': 0.1, '1': 0.5, '2': 0.4 },
      confidence: 0.6,
    },
  },
  usage: { input_tokens: 1000, output_tokens: 21 },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the request', () => {
  it('sends every question in one request, with the pinned model', async () => {
    const { calls } = stub(() => ok(answered));
    await runDecision({ secret: 'ts-key', state: 'the kitchen light', questions, timeoutMs: 500, log });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(call?.headers['authorization']).toBe('Bearer ts-key');
    // An alias is the vendor's to re-point, and re-pointing it would move the
    // model every threshold was calibrated against.
    expect(call?.body['model']).toBe(DECISION_MODEL);
    expect(Object.keys(call?.body['questions'] as object)).toEqual([
      'urgent',
      'where',
      'severity',
    ]);
  });

  it('sends a noul without criteria, and the other two with theirs', async () => {
    const { calls } = stub(() => ok(answered));
    await runDecision({ secret: 'k', state: 's', questions, timeoutMs: 500, log });
    const sent = calls[0]?.body['questions'] as Record<string, Record<string, unknown>>;
    expect(sent['urgent']).toEqual({ type: 'noul', instructions: 'It needs doing now.' });
    expect(sent['where']?.['criteria']).toEqual({ kitchen: 'The kitchen.', hall: 'The hall.' });
    expect(sent['severity']?.['criteria']).toEqual(['Fine.', 'Awkward.', 'Broken.']);
  });

  it('refuses an oversized state without making a request at all', async () => {
    const { calls } = stub(() => ok(answered));
    // The guard has to run *before* the fetch, which is the only thing an
    // empty call list can prove — `test/ai-page-fetch.test.ts`'s shape.
    await expect(
      runDecision({
        secret: 'k',
        state: 'x'.repeat(MAX_STATE_CHARS + 1),
        questions,
        timeoutMs: 500,
        log,
      }),
    ).rejects.toThrow(/over the/);
    expect(calls).toHaveLength(0);
  });
});

describe('reading the answers', () => {
  it('returns each answer in its own shape, and the request id', async () => {
    stub(() => ok(answered));
    const result = await runDecision({ secret: 'k', state: 's', questions, timeoutMs: 500, log });
    expect(result.answers.urgent).toEqual({ type: 'noul', noul: 0.91 });
    expect(result.answers.where?.choice).toBe('kitchen');
    expect(result.answers.where?.confidence).toBe(0.96);
    expect(result.answers.severity?.score).toBe(1.4);
    // Rebuilt from the criteria we sent: the index is the level.
    expect(result.answers.severity?.legend).toEqual({ '0': 'Fine.', '1': 'Awkward.', '2': 'Broken.' });
    expect(result.requestId).toBe('req-42');
  });

  it('a noul carries no confidence, so nothing can read one off it', async () => {
    stub(() => ok(answered));
    const result = await runDecision({ secret: 'k', state: 's', questions, timeoutMs: 500, log });
    expect(result.answers.urgent).not.toHaveProperty('confidence');
  });

  it('drops a choice outside the criteria rather than coercing it', async () => {
    // The type says the answer is one of the keys we offered. This is what
    // makes that true at runtime — a name we never offered is not an answer,
    // and a caller that switches on it has no arm for it.
    stub(() =>
      ok({
        ...answered,
        answers: {
          ...answered.answers,
          where: {
            type: 'choice',
            choice: 'garage',
            probabilities: { garage: 1 },
            confidence: 0.99,
          },
        },
      }),
    );
    const result = await runDecision({ secret: 'k', state: 's', questions, timeoutMs: 500, log });
    expect(result.answers.where).toBeUndefined();
    // The others in the same response still arrive.
    expect(result.answers.urgent?.noul).toBe(0.91);
  });

  it('drops a noul outside 0..1 and a score off the end of the rubric', async () => {
    stub(() =>
      ok({
        ...answered,
        answers: {
          urgent: { type: 'noul', noul: 1.4 },
          severity: {
            type: 'score',
            score: 9,
            probabilities: { '0': 1 },
            confidence: 0.9,
          },
        },
      }),
    );
    const result = await runDecision({ secret: 'k', state: 's', questions, timeoutMs: 500, log });
    expect(result.answers.urgent).toBeUndefined();
    expect(result.answers.severity).toBeUndefined();
  });

  it('survives a response that answered only some of what was asked', async () => {
    stub(() => ok({ model: DECISION_MODEL, answers: { urgent: { type: 'noul', noul: 0.2 } }, usage: {} }));
    const result = await runDecision({ secret: 'k', state: 's', questions, timeoutMs: 500, log });
    expect(result.answers.urgent?.noul).toBe(0.2);
    expect(result.answers.where).toBeUndefined();
  });
});

describe('what a decision costs', () => {
  it('counts input tokens only — output is reported and not billed', () => {
    expect(estimateDecisionCostUsd({ inputTokens: 1_000_000 })).toBeCloseTo(0.042, 6);
    expect(estimateDecisionCostUsd({ inputTokens: 0 })).toBe(0);
  });

  it('prices a real response off its own usage', async () => {
    stub(() => ok(answered));
    const result = await runDecision({ secret: 'k', state: 's', questions, timeoutMs: 500, log });
    // 1000 input tokens at $0.042/M. The 21 output tokens cost nothing.
    expect(result.costUsd).toBeCloseTo(0.000042, 9);
  });
});

describe('failures', () => {
  const statuses: [number, string][] = [
    [401, 'auth_failed'],
    [429, 'rate_limited'],
    [529, 'overloaded'],
    [503, 'overloaded'],
  ];
  for (const [status, kind] of statuses) {
    it(`classifies ${status} as ${kind}`, async () => {
      stub(() => new Response('{"error":"no"}', { status }));
      await expect(
        runDecision({ secret: 'k', state: 's', questions, timeoutMs: 500, log }),
      ).rejects.toMatchObject({ kind });
    });
  }

  it('a 422 is our own malformed question, and is not an availability failure', async () => {
    // It must never arm anything: a gate over a bug the hub has just shipped
    // would hide that bug behind a retry timer.
    stub(() => new Response('{"error":"bad questions"}', { status: 422 }));
    await expect(
      runDecision({ secret: 'k', state: 's', questions, timeoutMs: 500, log }),
    ).rejects.not.toHaveProperty('kind');
  });

  it('throws on a body that is not JSON', async () => {
    stub(() => new Response('<html>oops</html>', { status: 200 }));
    await expect(
      runDecision({ secret: 'k', state: 's', questions, timeoutMs: 500, log }),
    ).rejects.toThrow(/not JSON/);
  });
});

describe('the wrapper, which is what makes an outage invisible', () => {
  /**
   * The two things the wrapper asks: whether a decision can be asked at all,
   * and the connection it is asked on — the route with the key that route
   * chose, from one call, so the two can never come from different moments.
   */
  const settingsWith = (input: {
    hasKey?: boolean;
    enabled?: boolean;
    route?: 'direct' | 'vercel';
    secret?: string | null;
  }): SettingsService =>
    ({
      getAiSettings: async () => ({
        decision: {
          hasKey: input.hasKey ?? true,
          usable: input.hasKey ?? true,
          enabled: input.enabled ?? true,
          route: input.route ?? 'direct',
          model: DECISION_MODEL,
        },
      }),
      aiConnection: async () => {
        const secret = input.secret === undefined ? 'ts-key' : input.secret;
        return secret === null ? null : { secret, route: input.route ?? 'direct' };
      },
    }) as unknown as SettingsService;

  const one = { urgent: { type: 'noul', instructions: 'Now?' } } as const;

  it('answers null with no key, and makes no request', async () => {
    const { calls } = stub(() => ok(answered));
    const decider = lazyDecider({ settings: settingsWith({ hasKey: false }), log });
    expect(await decider.decide({ state: 's', questions: one, timeoutMs: 500 })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('answers null while the owner has it switched off', async () => {
    const { calls } = stub(() => ok(answered));
    const decider = lazyDecider({ settings: settingsWith({ enabled: false }), log });
    expect(await decider.decide({ state: 's', questions: one, timeoutMs: 500 })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('turns a refusal into null rather than throwing', async () => {
    // Every caller falls back to the path it had before, so a throw here would
    // put a try/catch at every call site instead of making it a property.
    stub(() => new Response('nope', { status: 500 }));
    const decider = lazyDecider({ settings: settingsWith({}), log });
    expect(await decider.decide({ state: 's', questions: one, timeoutMs: 500 })).toBeNull();
  });

  it('opens a breaker after repeated failures, and then costs no request at all', async () => {
    // "Invisible" has to mean no added *latency*, not merely no error: a
    // revoked key must stop costing every turn a full timeout.
    const { calls } = stub(() => new Response('nope', { status: 401 }));
    const decider = lazyDecider({ settings: settingsWith({}), log });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await decider.decide({ state: 's', questions: one, timeoutMs: 500 });
    }
    expect(calls).toHaveLength(3);
    await decider.decide({ state: 's', questions: one, timeoutMs: 500 });
    expect(calls).toHaveLength(3);
  });

  it('retires the breaker when the key changes', async () => {
    // A judgement about an account must not outlive the account — otherwise
    // the gate silences the very fix somebody was told to make.
    let secret = 'old-key';
    const settings = {
      getAiSettings: async () => ({
        decision: { hasKey: true, usable: true, enabled: true, route: 'direct', model: DECISION_MODEL },
      }),
      aiConnection: async () => ({ secret, route: 'direct' }),
    } as unknown as SettingsService;
    const { calls } = stub((call) =>
      call.headers['authorization'] === 'Bearer new-key'
        ? ok(answered)
        : new Response('nope', { status: 401 }),
    );
    const decider = lazyDecider({ settings, log });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await decider.decide({ state: 's', questions: one, timeoutMs: 500 });
    }
    await decider.decide({ state: 's', questions: one, timeoutMs: 500 });
    expect(calls).toHaveLength(3);

    secret = 'new-key';
    const result = await decider.decide({ state: 's', questions: one, timeoutMs: 500 });
    expect(calls).toHaveLength(4);
    expect(result?.answers.urgent?.noul).toBe(0.91);
  });

  it('sends the route\'s own address and model id, on the key that route chose', async () => {
    // A route is not a model: both serve the same one, and only the address,
    // the key and the string that address expects differ.
    const { calls } = stub(() => ok(answered));
    const decider = lazyDecider({
      settings: settingsWith({ route: 'vercel', secret: 'vck_gateway' }),
      log,
    });
    await decider.decide({ state: 's', questions: one, timeoutMs: 500 });
    expect(calls[0]?.url).toBe('https://ai-gateway.vercel.sh/typesafe/v1/systemone');
    expect(calls[0]?.body['model']).toBe('typesafe-ai/jev');
    expect(calls[0]?.headers['authorization']).toBe('Bearer vck_gateway');
  });

  it('asks TypeSafe itself on the direct route', async () => {
    const { calls } = stub(() => ok(answered));
    const decider = lazyDecider({ settings: settingsWith({}), log });
    expect(await decider.decide({ state: 's', questions: one, timeoutMs: 500 })).not.toBeNull();
    expect(calls[0]?.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(calls[0]?.body['model']).toBe(DECISION_MODEL);
  });

  it('answers null when the route it is on has no key, and makes no request', async () => {
    // A home that moved Jev onto the gateway and then removed the gateway's
    // key is back on TypeSafe's own — but one caught between the two reads
    // must fail open rather than send a request with nothing to sign it.
    const { calls } = stub(() => ok(answered));
    const decider = lazyDecider({ settings: settingsWith({ secret: null }), log });
    expect(await decider.decide({ state: 's', questions: one, timeoutMs: 500 })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('drops a second concurrent call rather than queueing it', async () => {
    // A queued decision arrives after the thing it was deciding, which is the
    // one behaviour that could make this slower than not having it at all.
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls } = stub(() => ok(answered));
    vi.stubGlobal('fetch', (async () => {
      calls.push({ url: '', headers: {}, body: {} });
      await held;
      return ok(answered);
    }) as unknown as typeof fetch);

    const decider = lazyDecider({ settings: settingsWith({}), log });
    const first = decider.decide({ state: 's', questions: one, timeoutMs: 500 });
    // Let the first get as far as the fetch before the second asks.
    await new Promise((resolve) => setImmediate(resolve));
    const second = await decider.decide({ state: 's', questions: one, timeoutMs: 500 });
    expect(second).toBeNull();
    release?.();
    expect((await first)?.answers.urgent?.noul).toBe(0.91);
    expect(calls).toHaveLength(1);
  });

  /**
   * A guess must never take the fast path away from the real thing.
   *
   * This is the rule the first version got wrong: one-at-a-time treated a
   * speculation and a live turn alike, so a speculation in flight answered
   * `null` to the very command it had been started for.
   */
  it('lets a live call overtake a speculation, and never the other way round', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    vi.stubGlobal('fetch', (async (_url: unknown, init?: RequestInit) => {
      started += 1;
      // The first call waits until it is either aborted or let go.
      if (started === 1) {
        await Promise.race([
          held,
          new Promise((_, reject) => {
            (init?.signal as AbortSignal | undefined)?.addEventListener('abort', () =>
              reject(new Error('aborted')),
            );
          }),
        ]);
      }
      return ok(answered);
    }) as unknown as typeof fetch);

    const decider = lazyDecider({ settings: settingsWith({}), log });
    const speculation = decider.decide({
      state: 's',
      questions: one,
      timeoutMs: 500,
      priority: 'speculative',
    });
    await new Promise((resolve) => setImmediate(resolve));

    // The live call goes through rather than being turned away.
    const live = await decider.decide({ state: 's', questions: one, timeoutMs: 500 });
    expect(live?.answers.urgent?.noul).toBe(0.91);
    // And the speculation it overtook answers nothing, quietly.
    expect(await speculation).toBeNull();
    release?.();
  });

  it('does not arm the breaker over a speculation that was overtaken', async () => {
    // Being overtaken is not a failure of the key, and counting it would open
    // the breaker against a perfectly good one during a talkative minute.
    let calls = 0;
    vi.stubGlobal('fetch', (async (_url: unknown, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        await new Promise((_, reject) => {
          (init?.signal as AbortSignal | undefined)?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        });
      }
      return ok(answered);
    }) as unknown as typeof fetch);

    const decider = lazyDecider({ settings: settingsWith({}), log });
    const speculation = decider.decide({
      state: 's',
      questions: one,
      timeoutMs: 500,
      priority: 'speculative',
    });
    await new Promise((resolve) => setImmediate(resolve));
    await decider.decide({ state: 's', questions: one, timeoutMs: 500 });
    expect(await speculation).toBeNull();

    // Still answering: nothing was armed.
    const after = await decider.decide({ state: 's', questions: one, timeoutMs: 500 });
    expect(after).not.toBeNull();
  });
});
