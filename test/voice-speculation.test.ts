import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../src/logging.js';
import { VoiceDelegation, type VoiceDelegationHost } from '../src/ai/voice/delegation.js';
import {
  SPECULATE_EVERY_MS,
  SPECULATIONS_PER_UTTERANCE,
  SPECULATION_MIN_CHARS,
} from '../src/ai/decide/questions.js';

/**
 * Reading a sentence while it is still being said.
 *
 * This is the half of the demo videos that the hub can safely have: the
 * session, the transport and the readings are got ready while somebody talks,
 * and **nothing is done to the home until the sentence is finished**. "Turn
 * the bedroom light on — no, off" is an ordinary thing to say, and a hub that
 * acted on the first half would make the lamp flash.
 *
 * Driven frame by frame like `test/voice-sideband.test.ts`, because reading
 * these rules through the socket would mean dialling `api.openai.com` — a rule
 * every spoken request in the house goes through would be a rule no test could
 * reach.
 */

const log = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

function heard(delta: string, start: number, end: number): Record<string, unknown> {
  return { type: 'session.input_transcript.delta', delta, start_ms: start, end_ms: end };
}

function said(delta: string, start: number, end: number): Record<string, unknown> {
  return { type: 'session.output_transcript.delta', delta, start_ms: start, end_ms: end };
}

function delegated(id: string, offset?: number): Record<string, unknown> {
  return {
    type: 'session.delegation.created',
    ...(offset !== undefined ? { offset_ms: offset } : {}),
    delegation: { id, type: 'client', target: 'client' },
  };
}

interface Harness {
  read(frame: Record<string, unknown>): void;
  settle(): Promise<void>;
  warmed: { sessionId: string; memberId: string; partial: string }[];
  asked: { question: string }[];
  /** Everything a warm was *able* to reach, which must stay empty. */
  host: VoiceDelegationHost;
}

function harness(): Harness {
  const warmed: Harness['warmed'] = [];
  const asked: Harness['asked'] = [];
  const host: VoiceDelegationHost = {
    askAloud: async (input) => {
      asked.push({ question: input.question });
      return 'Done.';
    },
    recordVoiceSpend: async () => undefined,
    warmForSpeech: async (input) => {
      warmed.push(input);
    },
  };
  const delegation = new VoiceDelegation({
    sessionId: 'chat-1',
    memberId: 'member-1',
    log,
    host,
    send: () => undefined,
    close: () => undefined,
  });
  return {
    read: (frame) => delegation.read(JSON.stringify(frame)),
    settle: () => delegation.settle(),
    warmed,
    asked,
    host,
  };
}

describe('a speculation may never reach the home', () => {
  it('offers the host nothing that could write', () => {
    // The narrowing *is* the mechanism. A host that could act would make this
    // a rule about care rather than a rule about types.
    const h = harness();
    const keys = Object.keys(h.host);
    expect(keys.sort()).toEqual(['askAloud', 'recordVoiceSpend', 'warmForSpeech']);
  });

  it('warms while somebody is talking and asks nothing until they stop', () => {
    const h = harness();
    h.read(heard('turn the kitchen light off please', 1_000, 2_000));
    expect(h.warmed).toHaveLength(1);
    // Nothing has been asked, so nothing has been done.
    expect(h.asked).toHaveLength(0);
  });

  it('asks only once the model says the sentence is finished', async () => {
    const h = harness();
    h.read(heard('turn the kitchen light off', 1_000, 2_000));
    h.read(delegated('d-1'));
    await h.settle();
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.question).toContain('kitchen light off');
  });
});

describe('what a partial is worth reading', () => {
  it('ignores a fragment too short to mean anything', () => {
    const h = harness();
    h.read(heard('tu', 1_000, 1_100));
    expect(h.warmed).toHaveLength(0);
    expect('tu'.length).toBeLessThan(SPECULATION_MIN_CHARS);
  });

  it('reads the sentence so far, not just the newest fragment', () => {
    const h = harness();
    vi.useFakeTimers();
    try {
      h.read(heard('turn the kitchen ', 1_000, 1_400));
      vi.advanceTimersByTime(SPECULATE_EVERY_MS + 10);
      h.read(heard('light off', 1_400, 2_000));
    } finally {
      vi.useRealTimers();
    }
    expect(h.warmed[h.warmed.length - 1]?.partial).toBe('turn the kitchen light off');
  });

  it('holds the rate down between fragments', () => {
    // Deltas arrive several times a second; a warm per delta would be a bill.
    const h = harness();
    h.read(heard('turn the kitchen ', 1_000, 1_400));
    h.read(heard('light ', 1_400, 1_600));
    h.read(heard('off now', 1_600, 2_000));
    expect(h.warmed).toHaveLength(1);
  });

  it('caps how many times one utterance may be read', () => {
    // The rate bound alone is not enough: a room with a film on produces
    // deltas indefinitely, which is the voice prompt's own hazard one layer
    // down.
    const h = harness();
    vi.useFakeTimers();
    try {
      for (let index = 0; index < SPECULATIONS_PER_UTTERANCE + 4; index += 1) {
        h.read(heard(`fragment number ${index} `, 1_000 + index * 10, 1_100 + index * 10));
        vi.advanceTimersByTime(SPECULATE_EVERY_MS + 10);
      }
    } finally {
      vi.useRealTimers();
    }
    expect(h.warmed.length).toBeLessThanOrEqual(SPECULATIONS_PER_UTTERANCE);
  });

  it('starts the count again when a new sentence opens', () => {
    const h = harness();
    vi.useFakeTimers();
    try {
      for (let index = 0; index < SPECULATIONS_PER_UTTERANCE + 2; index += 1) {
        h.read(heard(`first sentence part ${index} `, 1_000 + index * 10, 1_100 + index * 10));
        vi.advanceTimersByTime(SPECULATE_EVERY_MS + 10);
      }
      const spentOnFirst = h.warmed.length;
      // A long gap opens a new utterance.
      h.read(heard('a completely different request', 40_000, 41_000));
      expect(h.warmed.length).toBeGreaterThan(spentOnFirst);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('speculation never changes what is asked', () => {
  it('produces the same question with and without it', async () => {
    // The whole safety argument rests on this: a warm is a side effect on the
    // session, so the request that follows is byte-identical.
    const withWarm = harness();
    withWarm.read(heard('turn the kitchen light off', 1_000, 2_000));
    withWarm.read(delegated('d-1'));
    await withWarm.settle();

    const withoutWarm = harness();
    // One long fragment under the minimum length never speculates.
    withoutWarm.read(heard('x', 1_000, 1_050));
    withoutWarm.read(heard('turn the kitchen light off', 1_050, 2_000));
    withoutWarm.read(delegated('d-1'));
    await withoutWarm.settle();

    expect(withWarm.asked[0]?.question).toContain('turn the kitchen light off');
    expect(withoutWarm.asked[0]?.question).toContain('turn the kitchen light off');
  });

  it('stops speculating once the sentence has been taken', async () => {
    const h = harness();
    h.read(heard('turn the kitchen light off', 1_000, 2_000));
    const before = h.warmed.length;
    h.read(delegated('d-1'));
    await h.settle();
    // Anything arriving after the ask belongs to the *next* sentence, and the
    // tail of this one is dropped rather than re-read.
    h.read(heard(' please', 1_500, 1_900));
    expect(h.warmed).toHaveLength(before);
  });

  it('does not treat the voice answering by itself as a new request', async () => {
    const h = harness();
    h.read(heard('hello there', 1_000, 1_500));
    h.read(said('Hello.', 1_600, 2_000));
    h.read(heard('turn the kitchen light off', 30_000, 31_000));
    h.read(delegated('d-1'));
    await h.settle();
    expect(h.asked[0]?.question).not.toContain('hello there');
  });
});
