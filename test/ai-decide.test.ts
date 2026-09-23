import { describe, expect, it } from 'vitest';
import type { Logger } from '../src/logging.js';
import type { DecisionFetch, DecisionTransport } from '../src/ai/decide/connection.js';
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
 * The transport is handed in and answers with **real `Response` objects**
 * rather than parsed bodies, for the reason `test/ai-openai-chat.test.ts`
 * learned the hard way: a mock laxer than the thing it stands in for tests the
 * mock. It stands in for the network and nothing else — every rule about what
 * a reply means still runs. Every case below is either something the vendor
 * can send that the hub has to survive, or something the hub must never send.
 */

const log = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
  signal: AbortSignal | undefined;
}

/** A transport that records exactly what was sent, and answers as told. */
function wire(
  responder: (call: Call) => Response | Promise<Response>,
  options: { warm?: () => boolean } = {},
): { calls: Call[]; fetch: DecisionFetch; transport: DecisionTransport } {
  const calls: Call[] = [];
  const fetch: DecisionFetch = async (url, init) => {
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
      signal: init.signal ?? undefined,
    };
    calls.push(call);
    return responder(call);
  };
  return { calls, fetch, transport: { fetch, isWarm: options.warm ?? (() => false) } };
}

/** An answer that never comes, and rejects the way the real one does when aborted. */
function untilAborted(call: Call): Promise<Response> {
  return new Promise((_, reject) => {
    call.signal?.addEventListener('abort', () =>
      reject(new DOMException('This operation was aborted', 'AbortError')),
    );
  });
}

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-typesafe-request-id': 'req-42' },
  });

const questions = {
  urgent: { type: 'noul', instructions: 'It needs doing now.' },
  twice: {
    type: 'noul',
    instructions: 'It asks for two things.',
    criteria: { true: 'Like "on and off".', false: 'Like "all the lights".' },
  },
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
    twice: { type: 'noul', noul: 0.12 },
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

describe('the request', () => {
  it('sends every question in one request, with the pinned model', async () => {
    const { calls, fetch } = wire(() => ok(answered));
    await runDecision({ secret: 'ts-key', state: 'the kitchen light', questions, timeoutMs: 500, fetch, log });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(call?.method).toBe('POST');
    expect(call?.headers['authorization']).toBe('Bearer ts-key');
    // An alias is the vendor's to re-point, and re-pointing it would move the
    // model every threshold was calibrated against.
    expect(call?.body?.['model']).toBe(DECISION_MODEL);
    expect(Object.keys(call?.body?.['questions'] as object)).toEqual([
      'urgent',
      'twice',
      'where',
      'severity',
    ]);
  });

  it('sends a noul’s criteria only when it has them', async () => {
    // Optional on the wire, and the place a boundary case goes for a model
    // that reads literally.
    const { calls, fetch } = wire(() => ok(answered));
    await runDecision({ secret: 'k', state: 's', questions, timeoutMs: 500, fetch, log });
    const sent = calls[0]?.body?.['questions'] as Record<string, Record<string, unknown>>;
    expect(sent['urgent']).toEqual({ type: 'noul', instructions: 'It needs doing now.' });
    expect(sent['twice']).toEqual({
      type: 'noul',
      instructions: 'It asks for two things.',
      criteria: { true: 'Like "on and off".', false: 'Like "all the lights".' },
    });
    expect(sent['where']?.['criteria']).toEqual({ kitchen: 'The kitchen.', hall: 'The hall.' });
    expect(sent['severity']?.['criteria']).toEqual(['Fine.', 'Awkward.', 'Broken.']);
  });

  it('sends a structured state as JSON, as it was given', async () => {
    const { calls, fetch } = wire(() => ok(answered));
    await runDecision({
      secret: 'k',
      state: { parts: ['turn off the TV', 'what time is it'], amounts: [null, null] },
      questions,
      timeoutMs: 500,
      fetch,
      log,
    });
    expect(calls[0]?.body?.['state']).toEqual({
      parts: ['turn off the TV', 'what time is it'],
      amounts: [null, null],
    });
  });

  it('refuses an oversized state without making a request at all', async () => {
    const { calls, fetch } = wire(() => ok(answered));
    // The guard has to run *before* the request, which is the only thing an
    // empty call list can prove — `test/ai-page-fetch.test.ts`'s shape.
    await expect(
      runDecision({
        secret: 'k',
        state: 'x'.repeat(MAX_STATE_CHARS + 1),
        questions,
        timeoutMs: 500,
        fetch,
        log,
      }),
    ).rejects.toThrow(/over the/);
    expect(calls).toHaveLength(0);
  });
});

describe('reading the answers', () => {
  it('returns each answer in its own shape, and the request id', async () => {
    const { fetch } = wire(() => ok(answered));
    const result = await runDecision({ secret: 'k', state: 's', questions, timeoutMs: 500, fetch, log });
    expect(result.answers.urgent).toEqual({ type: 'noul', noul: 0.91 });
    expect(result.answers.where?.choice).toBe('kitchen');
    expect(result.answers.where?.confidence).toBe(0.96);
    expect(result.answers.severity?.score).toBe(1.4);
    // Rebuilt from the criteria we sent: the index is the level.
    expect(result.answers.severity?.legend).toEqual({ '0': 'Fine.', '1': 'Awkward.', '2': 'Broken.' });
    expect(result.requestId).toBe('req-42');
  });

  it('a noul carries no confidence, so nothing can read one off it', async () => {
    const { fetch } = wire(() => ok(answered));
    const result = await runDecision({ secret: 'k', state: 's', questions, timeoutMs: 500, fetch, log });
    expect(result.answers.urgent).not.toHaveProperty('confidence');
  });

  it('drops a choice outside the criteria rather than coercing it', async () => {
    // The type says the answer is one of the keys we offered. This is what
    // makes that true at runtime — a name we never offered is not an answer,
    // and a caller that switches on it has no arm for it.
    const { fetch } = wire(() =>
      ok({
        ...answered,
        answers: {
          ...answered.answers,
          where: { type: 'choice', choice: 'garage', probabilities: { garage: 1 }, confidence: 0.99 },
        },
      }),
    );
    const result = await runDecision({ secret: 'k', state: 's', questions, timeoutMs: 500, fetch, log });
    expect(result.answers.where).toBeUndefined();
    // The others in the same response still arrive.
    expect(result.answers.urgent?.noul).toBe(0.91);
  });

  it('drops a noul outside 0..1 and a score off the end of the rubric', async () => {
    const { fetch } = wire(() =>
      ok({
        ...answered,
        answers: {
          urgent: { type: 'noul', noul: 1.4 },
          severity: { type: 'score', score: 9, probabilities: { '0': 1 }, confidence: 0.9 },
        },
      }),
    );
    const result = await runDecision({ secret: 'k', state: 's', questions, timeoutMs: 500, fetch, log });
    expect(result.answers.urgent).toBeUndefined();
    expect(result.answers.severity).toBeUndefined();
  });

  it('survives a response that answered only some of what was asked', async () => {
    const { fetch } = wire(() =>
      ok({ model: DECISION_MODEL, answers: { urgent: { type: 'noul', noul: 0.2 } }, usage: {} }),
    );
    const result = await runDecision({ secret: 'k', state: 's', questions, timeoutMs: 500, fetch, log });
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
    const { fetch } = wire(() => ok(answered));
    const result = await runDecision({ secret: 'k', state: 's', questions, timeoutMs: 500, fetch, log });
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
      const { fetch } = wire(() => new Response('{"error":"no"}', { status }));
      await expect(
        runDecision({ secret: 'k', state: 's', questions, timeoutMs: 500, fetch, log }),
      ).rejects.toMatchObject({ kind });
    });
  }

  it('a 422 is our own malformed question, and is not an availability failure', async () => {
    // It must never arm anything: a gate over a bug the hub has just shipped
    // would hide that bug behind a retry timer.
    const { fetch } = wire(() => new Response('{"error":"bad questions"}', { status: 422 }));
    await expect(
      runDecision({ secret: 'k', state: 's', questions, timeoutMs: 500, fetch, log }),
    ).rejects.not.toHaveProperty('kind');
  });

  it('throws on a body that is not JSON', async () => {
    const { fetch } = wire(() => new Response('<html>oops</html>', { status: 200 }));
    await expect(
      runDecision({ secret: 'k', state: 's', questions, timeoutMs: 500, fetch, log }),
    ).rejects.toThrow(/not JSON/);
  });

  it('says a deadline passed as itself, not as the abort it caused', async () => {
    // The watchdog aborts the request, and an aborted request throws an
    // `AbortError` like any other cancellation — so without its own error,
    // "it was too slow" and "somebody stopped it" read alike.
    const { fetch } = wire(untilAborted);
    await expect(
      runDecision({ secret: 'k', state: 's', questions, timeoutMs: 20, fetch, log }),
    ).rejects.toMatchObject({ name: 'DecisionTimeoutError', timeoutMs: 20 });
  });
});

describe('the wrapper, which is what makes an outage invisible', () => {
  const settingsWith = (input: {
    hasKey?: boolean;
    enabled?: boolean;
    secret?: () => string | null;
  }): SettingsService =>
    ({
      getAiSettings: async () => ({
        decision: {
          hasKey: input.hasKey ?? true,
          enabled: input.enabled ?? true,
          model: DECISION_MODEL,
        },
      }),
      aiKey: async () => (input.secret === undefined ? 'ts-key' : input.secret()),
    }) as unknown as SettingsService;

  const one = { urgent: { type: 'noul', instructions: 'Now?' } } as const;

  /** A transport whose requests wait until the test lets them go. */
  function held(): {
    calls: Call[];
    transport: DecisionTransport;
    release: () => void;
  } {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls, transport } = wire(async (call) => {
      await Promise.race([gate, untilAborted(call)]);
      return ok(answered);
    });
    return { calls, transport, release: () => release() };
  }

  it('answers null with no key, and makes no request', async () => {
    const { calls, transport } = wire(() => ok(answered));
    const decider = lazyDecider({ settings: settingsWith({ hasKey: false }), log, transport });
    expect(await decider.decide({ state: 's', questions: one, timeoutMs: 500 })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('answers null while the owner has it switched off', async () => {
    const { calls, transport } = wire(() => ok(answered));
    const decider = lazyDecider({ settings: settingsWith({ enabled: false }), log, transport });
    expect(await decider.decide({ state: 's', questions: one, timeoutMs: 500 })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('turns a refusal into null rather than throwing', async () => {
    // Every caller falls back to the path it had before, so a throw here would
    // put a try/catch at every call site instead of making it a property.
    const { transport } = wire(() => new Response('nope', { status: 500 }));
    const decider = lazyDecider({ settings: settingsWith({}), log, transport });
    expect(await decider.decide({ state: 's', questions: one, timeoutMs: 500 })).toBeNull();
  });

  it('says whether the request had to open a connection first', async () => {
    // The handshake is most of a decision's latency when it happens, so a slow
    // reading with this set is a cold hub rather than a slow model.
    let warm = false;
    const { transport } = wire(() => ok(answered), { warm: () => warm });
    const decider = lazyDecider({ settings: settingsWith({}), log, transport });
    expect((await decider.decide({ state: 's', questions: one, timeoutMs: 500 }))?.newConnection).toBe(true);
    warm = true;
    expect((await decider.decide({ state: 's', questions: one, timeoutMs: 500 }))?.newConnection).toBe(false);
  });

  it('opens a breaker after repeated failures, and then costs no request at all', async () => {
    // "Invisible" has to mean no added *latency*, not merely no error: a
    // revoked key must stop costing every turn a full timeout.
    const { calls, transport } = wire(() => new Response('nope', { status: 401 }));
    const decider = lazyDecider({ settings: settingsWith({}), log, transport });
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
    const { calls, transport } = wire((call) =>
      call.headers['authorization'] === 'Bearer new-key' ? ok(answered) : new Response('nope', { status: 401 }),
    );
    const decider = lazyDecider({ settings: settingsWith({ secret: () => secret }), log, transport });
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

  /**
   * **A guess gives way; the real thing never does.**
   *
   * The first version ran one request at a time and aborted a speculation
   * when a live call arrived — and aborting a request mid-flight destroys the
   * connection under it, so the live call it was making room for paid for a
   * fresh handshake instead.
   */
  describe('who gives way', () => {
    it('drops a speculation while anything is out, and asks nobody', async () => {
      // A queued guess arrives after the sentence it was guessing about, which
      // is the one way this could make a turn slower than not having it.
      const { calls, transport, release } = held();
      const decider = lazyDecider({ settings: settingsWith({}), log, transport });
      const live = decider.decide({ state: 's', questions: one, timeoutMs: 500 });
      await new Promise((resolve) => setImmediate(resolve));

      const heard: string[] = [];
      const guess = await decider.decide({
        state: 's',
        questions: one,
        timeoutMs: 500,
        priority: 'speculative',
        onMiss: (why) => heard.push(why),
      });
      expect(guess).toBeNull();
      expect(heard).toEqual(['busy']);
      expect(calls).toHaveLength(1);
      release();
      expect((await live)?.answers.urgent?.noul).toBe(0.91);
    });

    it('lets a live call go beside a speculation, and aborts neither', async () => {
      const { calls, transport, release } = held();
      const decider = lazyDecider({ settings: settingsWith({}), log, transport });
      const guess = decider.decide({ state: 's', questions: one, timeoutMs: 500, priority: 'speculative' });
      await new Promise((resolve) => setImmediate(resolve));

      const live = decider.decide({ state: 's', questions: one, timeoutMs: 500 });
      await new Promise((resolve) => setImmediate(resolve));
      // Both are out at once, and the speculation's request was left alone.
      expect(calls).toHaveLength(2);
      expect(calls[0]?.signal?.aborted).toBe(false);

      release();
      expect((await live)?.answers.urgent?.noul).toBe(0.91);
      expect((await guess)?.answers.urgent?.noul).toBe(0.91);
    });

    it('never turns a live call away because another is out', async () => {
      // Two people talking to one house is ordinary, and neither of their
      // lights should take four seconds because of the other.
      const { calls, transport, release } = held();
      const decider = lazyDecider({ settings: settingsWith({}), log, transport });
      const first = decider.decide({ state: 'a', questions: one, timeoutMs: 500 });
      await new Promise((resolve) => setImmediate(resolve));
      const second = decider.decide({ state: 'b', questions: one, timeoutMs: 500 });
      await new Promise((resolve) => setImmediate(resolve));
      expect(calls).toHaveLength(2);
      release();
      expect(await first).not.toBeNull();
      expect(await second).not.toBeNull();
    });

    it('lets a speculation go once nothing else is out', async () => {
      const { calls, transport } = wire(() => ok(answered));
      const decider = lazyDecider({ settings: settingsWith({}), log, transport });
      await decider.decide({ state: 's', questions: one, timeoutMs: 500 });
      const guess = await decider.decide({ state: 's', questions: one, timeoutMs: 500, priority: 'speculative' });
      expect(guess).not.toBeNull();
      expect(calls).toHaveLength(2);
    });
  });

  /**
   * **Every `null` says which one it was, and none of them answers any
   * differently.** The reason is for a log line and a trail step — "why was
   * that not instant?" deserves better than a guess — and never for a branch,
   * so the contract stays exactly `null`.
   */
  it('says why it answered nothing', async () => {
    const heard: string[] = [];
    const onMiss = (why: string): void => {
      heard.push(why);
    };
    const quiet = wire(() => ok(answered));
    await lazyDecider({ settings: settingsWith({ hasKey: false }), log, transport: quiet.transport }).decide({
      state: 's',
      questions: one,
      timeoutMs: 500,
      onMiss,
    });
    await lazyDecider({ settings: settingsWith({ enabled: false }), log, transport: quiet.transport }).decide({
      state: 's',
      questions: one,
      timeoutMs: 500,
      onMiss,
    });

    const refusing = wire(() => new Response('nope', { status: 401 }));
    const failing = lazyDecider({ settings: settingsWith({}), log, transport: refusing.transport });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await failing.decide({ state: 's', questions: one, timeoutMs: 500, onMiss })).toBeNull();
    }
    // Three that failed, and then the breaker — which asked nobody.
    expect(heard).toEqual(['off', 'off', 'failed', 'failed', 'failed', 'resting']);
  });

  it('tells a timeout from a failure, and says whether it was dialling', async () => {
    const { transport } = wire(untilAborted);
    const heard: { why: string; newConnection: boolean | undefined }[] = [];
    const result = await lazyDecider({ settings: settingsWith({}), log, transport }).decide({
      state: 's',
      questions: one,
      timeoutMs: 20,
      onMiss: (why, detail) => heard.push({ why, newConnection: detail?.newConnection }),
    });
    expect(result).toBeNull();
    expect(heard).toEqual([{ why: 'timeout', newConnection: true }]);
  });

  describe('getting the connection ready', () => {
    it('opens it with the cheapest authenticated request there is', async () => {
      const { calls, transport } = wire(() => ok({ data: [] }));
      await lazyDecider({ settings: settingsWith({}), log, transport }).warm?.();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        url: 'https://api.typesafe.ai/v1/models',
        method: 'GET',
        headers: { authorization: 'Bearer ts-key' },
      });
    });

    it('does nothing without a key, while switched off, or when a connection is already open', async () => {
      for (const [settings, warm] of [
        [settingsWith({ hasKey: false }), false],
        [settingsWith({ enabled: false }), false],
        [settingsWith({}), true],
      ] as const) {
        const { calls, transport } = wire(() => ok({}), { warm: () => warm });
        await lazyDecider({ settings, log, transport }).warm?.();
        expect(calls).toHaveLength(0);
      }
    });

    it('does nothing while a decision is out: that one is opening it already', async () => {
      const { calls, transport, release } = held();
      const decider = lazyDecider({ settings: settingsWith({}), log, transport });
      const live = decider.decide({ state: 's', questions: one, timeoutMs: 500 });
      await new Promise((resolve) => setImmediate(resolve));
      await decider.warm?.();
      expect(calls).toHaveLength(1);
      release();
      await live;
    });

    it('opens one connection for several people opening the page at once', async () => {
      let answer: (() => void) | undefined;
      const { calls, transport } = wire(
        () =>
          new Promise<Response>((resolve) => {
            answer = () => resolve(ok({}));
          }),
      );
      const decider = lazyDecider({ settings: settingsWith({}), log, transport });
      const first = decider.warm?.();
      const second = decider.warm?.();
      await new Promise((resolve) => setImmediate(resolve));
      expect(calls).toHaveLength(1);
      answer?.();
      await Promise.all([first, second]);
    });

    it('never throws, whatever the far end does', async () => {
      const { transport } = wire(() => {
        throw new Error('ECONNREFUSED');
      });
      await expect(lazyDecider({ settings: settingsWith({}), log, transport }).warm?.()).resolves.toBeUndefined();
    });

    it('does not warm against a key the breaker is resting on', async () => {
      const { calls, transport } = wire(() => new Response('nope', { status: 401 }));
      const decider = lazyDecider({ settings: settingsWith({}), log, transport });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await decider.decide({ state: 's', questions: one, timeoutMs: 500 });
      }
      expect(calls).toHaveLength(3);
      await decider.warm?.();
      expect(calls).toHaveLength(3);
    });
  });
});
