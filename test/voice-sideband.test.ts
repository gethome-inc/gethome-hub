import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../src/logging.js';
import { LIVE_APPEND_CHARS, liveSidebandUrl } from '../src/ai/voice/live-wire.js';
import { VoiceDelegation, frameType } from '../src/ai/voice/delegation.js';

/**
 * The hub's half of a spoken request, driven frame by frame.
 *
 * **This is the suite the phone could never have had.** All of this logic used
 * to live in `VoiceConversation.swift`, in a repository with no test target, on
 * a surface whose only other verification is a green `xcodebuild` — so the one
 * rule that decides whether the house answers out loud was checked by talking
 * to it. `VoiceDelegation` is the same rules with no socket in front of them
 * (`sideband.ts` owns that), which is what makes them reachable from here.
 *
 * The rule worth the whole file is the **supersede** one: transcription lags
 * the delegation, so the closing fragments of a request land *after* the model
 * has asked for help, and a version of this that counted fragments demoted
 * nearly every answer in the house from *spoken* to merely *known* — using the
 * very sentence that asked for it. That failure is silent, it is total, and it
 * looks exactly like a model that has decided not to talk.
 */

const log = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

interface Harness {
  read(frame: Record<string, unknown>): void;
  raw(frame: string): void;
  settle(): Promise<void>;
  sent: Record<string, unknown>[];
  closes: number;
  asked: { sessionId: string; memberId: string; question: string }[];
  spend: { sessionId: string; seconds: number }[];
}

/** One conversation, with the two host calls recorded and the wire in an array. */
function harness(
  answers: (question: string) => Promise<string | null> = async () => 'It is off now.',
): Harness {
  const sent: Record<string, unknown>[] = [];
  const asked: Harness['asked'] = [];
  const spend: Harness['spend'] = [];
  let closes = 0;

  const delegation = new VoiceDelegation({
    sessionId: 'chat-1',
    memberId: 'member-1',
    log,
    host: {
      askAloud: async (input) => {
        asked.push(input);
        return answers(input.question);
      },
      recordVoiceSpend: async (input) => {
        spend.push(input);
      },
    },
    send: (frame) => {
      sent.push(frame);
    },
    close: () => {
      closes += 1;
    },
  });

  return {
    read: (frame) => delegation.read(JSON.stringify(frame)),
    raw: (frame) => delegation.read(frame),
    settle: () => delegation.settle(),
    sent,
    asked,
    spend,
    get closes() {
      return closes;
    },
  };
}

/** What the person said, as the API sends it: fragments on a session clock. */
function heard(delta: string, start: number, end: number): Record<string, unknown> {
  return { type: 'session.input_transcript.delta', delta, start_ms: start, end_ms: end };
}

function delegated(id: string, offset?: number): Record<string, unknown> {
  return {
    type: 'session.delegation.created',
    ...(offset !== undefined ? { offset_ms: offset } : {}),
    delegation: { id, type: 'client', target: 'client' },
  };
}

describe('the sideband drops audio before it parses anything', () => {
  it('recognises an audio frame from its prefix', () => {
    const audio = `{"type":"session.output_audio.delta","delta":"${'A'.repeat(6_000)}"}`;
    expect(frameType(audio)).toBe('session.output_audio.delta');
    expect(frameType('{"type":"session.input_transcript.delta","delta":"turn the"}')).toBe(
      'session.input_transcript.delta',
    );
  });

  it('reports an unscannable frame as unknown rather than guessing', () => {
    // JSON does not promise field order. A frame whose `type` sits past the
    // prefix must fall through to the real parse, not be mistaken for audio.
    const awkward = `{"delta":"${'A'.repeat(600)}","type":"session.output_audio.delta"}`;
    expect(frameType(awkward)).toBeUndefined();
  });

  it('acts on neither shape of audio frame, nor on rubbish', () => {
    const h = harness();
    h.raw(`{"type":"session.input_audio.append","audio":"${'A'.repeat(9_000)}"}`);
    h.raw(`{"audio":"${'A'.repeat(600)}","type":"session.output_audio.delta"}`);
    h.raw('not json at all');
    h.raw('{"no":"type"}');
    h.read({ type: 'session.commentary.appended', client_event_id: 'commentary_1_2' });

    // Nothing was said, so a delegation now has nothing to hand over — which is
    // the assertion that none of the above was read as speech.
    h.read(delegated('item_1', 500));
    expect(h.asked).toEqual([]);
    expect(h.sent).toEqual([]);
  });
});

describe('a spoken request', () => {
  it('is assembled from its fragments and answered out loud', async () => {
    const h = harness();
    h.read(heard('turn the ', 1_000, 1_400));
    h.read(heard('kitchen light off', 1_400, 2_000));
    h.read(delegated('item_1', 2_050));
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));

    expect(h.asked).toEqual([
      { sessionId: 'chat-1', memberId: 'member-1', question: 'turn the kitchen light off' },
    ]);
    expect(h.sent[0]).toMatchObject({
      type: 'session.commentary.append',
      delegation_id: 'item_1',
      content: 'It is off now.',
    });
  });

  it('keeps two things said as two lines rather than one run-on sentence', async () => {
    // The deltas carry no punctuation between utterances, so a greeting, a
    // pause and then a request concatenated into `Hi turn the kitchen light
    // off` — asked of the agent that way and shown that way in the row an app
    // draws. The session's own clock already says they were two.
    const h = harness();
    h.read(heard('Hi', 1_000, 1_300));
    h.read(heard('turn the kitchen light off', 5_000, 6_000));
    h.read(delegated('item_1', 6_050));
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));

    expect(h.asked[0]?.question).toBe('Hi\nturn the kitchen light off');
  });

  it('keeps one sentence’s own fragments on one line', async () => {
    // The other half, and the one that would regress silently: a pause inside
    // a sentence is not a new thing said, so nothing is inserted between the
    // fragments of it.
    const h = harness();
    h.read(heard('turn the ', 1_000, 1_400));
    h.read(heard('kitchen light off', 1_600, 2_000));
    h.read(delegated('item_1', 2_050));
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));

    expect(h.asked[0]?.question).toBe('turn the kitchen light off');
  });

  it('is spoken even though the tail of it was transcribed after the ask', async () => {
    // **The regression this file exists for.** The model asks for help the
    // moment it has understood, so " off" lands after the notice. It must
    // neither demote this answer nor turn up on the front of the next request.
    const h = harness();
    h.read(heard('turn the kitchen light', 1_000, 1_800));
    h.read(delegated('item_1', 1_900));
    h.read(heard(' off', 1_800, 2_100));
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]).toMatchObject({ type: 'session.commentary.append' });

    h.read(heard('and the lamp', 4_000, 4_600));
    h.read(delegated('item_2', 4_700));
    await vi.waitFor(() => expect(h.asked).toHaveLength(2));
    expect(h.asked[1]?.question).toBe('and the lamp');
  });

  it('is handed over as knowledge once the person has moved on', async () => {
    // Held open, so something new can be said while the hub is still thinking.
    let release: ((answer: string) => void) | undefined;
    const h = harness(() => new Promise<string>((resolve) => (release = resolve)));

    h.read(heard('is the heater on', 1_000, 1_800));
    h.read(delegated('item_1', 1_900));
    await vi.waitFor(() => expect(h.asked).toHaveLength(1));

    // Speech that *began* after the ask is a new thing said, not the tail of
    // the old one.
    h.read(heard('actually never mind', 3_000, 3_600));
    release?.('The heater is off.');

    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]).toMatchObject({
      type: 'session.thinking.append',
      delegation_id: 'item_1',
      // Nothing is thrown away: by now the hub has already done the thing.
      content: 'The heater is off.',
    });
  });

  it('is spoken when the session sends no timeline at all', async () => {
    const h = harness();
    h.read({ type: 'session.input_transcript.delta', delta: 'lights out' });
    h.read({ type: 'session.delegation.created', delegation: { id: 'item_1' } });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]).toMatchObject({ type: 'session.commentary.append' });
  });

  it('runs one job for a delegation delivered twice', async () => {
    const h = harness();
    h.read(heard('lights out', 1_000, 1_500));
    h.read(delegated('item_1', 1_600));
    h.read(delegated('item_1', 1_600));
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.asked).toHaveLength(1);
  });

  it('hands nothing over for a delegation with nothing said behind it', async () => {
    const h = harness();
    h.read(delegated('item_1', 400));
    await Promise.resolve();
    expect(h.asked).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it('ignores a delegation aimed at something other than this client', async () => {
    const h = harness();
    h.read(heard('lights out', 1_000, 1_500));
    h.read({
      type: 'session.delegation.created',
      delegation: { id: 'item_1', target: 'responses' },
    });
    await Promise.resolve();
    expect(h.asked).toEqual([]);
  });

  it('says so briefly when the home could not work it out', async () => {
    for (const answer of [null, '   ']) {
      const h = harness(async () => answer);
      h.read(heard('what is the airing cupboard doing', 1_000, 2_000));
      h.read(delegated('item_1', 2_100));
      await vi.waitFor(() => expect(h.sent).toHaveLength(1));
      expect(h.sent[0]).toMatchObject({ type: 'session.thinking.append' });
      expect(String(h.sent[0]?.['content'])).toContain('could not be worked out');
    }
  });

  it('clips an answer to what one append may carry', async () => {
    const h = harness(async () => 'x'.repeat(LIVE_APPEND_CHARS * 2));
    h.read(heard('tell me everything', 1_000, 2_000));
    h.read(delegated('item_1', 2_100));
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(String(h.sent[0]?.['content'])).toHaveLength(LIVE_APPEND_CHARS);
  });

  it('carries on when the home throws', async () => {
    const h = harness(async () => {
      throw new Error('the assistant is not configured');
    });
    h.read(heard('lights out', 1_000, 1_500));
    h.read(delegated('item_1', 1_600));
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]).toMatchObject({ type: 'session.thinking.append' });
  });
});

describe('what the line cost', () => {
  it('is the newest snapshot, not a running total', async () => {
    const h = harness();
    h.read({ type: 'session.usage.updated', usage: { seconds: 12 } });
    h.read({ type: 'session.usage.updated', usage: { seconds: 31 } });
    // A frame carrying no number leaves the last one we saw standing.
    h.read({ type: 'session.usage.updated', usage: {} });
    await h.settle();
    expect(h.spend).toEqual([{ sessionId: 'chat-1', seconds: 31 }]);
  });

  it('is recorded once, however many times the line ends', async () => {
    const h = harness();
    h.read({ type: 'session.usage.updated', usage: { seconds: 8 } });
    h.read({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 9 } });
    // The frame asks the socket to go, which is what closes it here.
    expect(h.closes).toBe(1);
    await h.settle();
    await h.settle();
    expect(h.spend).toEqual([{ sessionId: 'chat-1', seconds: 9 }]);
  });

  /**
   * **A session that never said what it cost still has to be settled**, which
   * is the half this used to assert the absence of.
   *
   * `session.usage.updated` arrives about once a minute, so the sessions that
   * carry no number are precisely the short ones — a phone force-quit forty
   * seconds in, a train tunnel. The host hangs two things off this call: what
   * the line cost, and whether the conversation is still being *spoken* to. Not
   * calling it left the second one marked, so a follow-up typed into the same
   * conversation hours later was logged as speech. Zero is the honest figure,
   * and `AssistantChat.recordVoiceSpend` writes no `ai_runs` row for it —
   * `$0.00` against a line that plainly ran is a claim where nothing is true.
   */
  it('is settled at zero for a session that never said, so the mark still clears', async () => {
    const h = harness();
    h.read({ type: 'session.closed', reason: 'connection_lost' });
    await h.settle();
    expect(h.spend).toEqual([{ sessionId: 'chat-1', seconds: 0 }]);

    // Still once, however many times the line ends.
    await h.settle();
    expect(h.spend).toHaveLength(1);
  });
});

describe('a round that takes too long', () => {
  /**
   * **The phone hangs up before the hub gives up, so the hub has to speak.**
   *
   * `VoiceConversation`'s idle clock closes a line after a minute with nothing
   * said and nothing playing, and the assistant is allowed a two-minute round —
   * so a slow answer used to arrive at a session that had already gone, and the
   * person heard "one moment" and then nothing, ever. Making the phone more
   * patient is the wrong side: that clock is there for a page left on a kitchen
   * counter. This side knows a round is running.
   */
  it('says so on the same delegation, and stops the moment the answer lands', async () => {
    vi.useFakeTimers();
    try {
      let release: (answer: string) => void = () => undefined;
      const h = harness(() => new Promise<string>((resolve) => (release = resolve)));
      h.read({ type: 'session.input_transcript.delta', delta: 'why is the hall light on' });
      h.read({ type: 'session.delegation.created', delegation: { id: 'item_1', target: 'client' } });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.sent).toEqual([]);

      await vi.advanceTimersByTimeAsync(20_000);
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]).toMatchObject({
        type: 'session.commentary.append',
        delegation_id: 'item_1',
      });

      // It repeats, because two minutes of assistant is four of these.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(h.sent).toHaveLength(2);

      release('The hall light is on because of the evening rule.');
      await vi.advanceTimersByTimeAsync(0);
      expect(h.sent).toHaveLength(3);
      expect(h.sent[2]).toMatchObject({ content: 'The hall light is on because of the evening rule.' });

      // And nothing more, however long nobody says anything else.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(h.sent).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  /** An ordinary round never sees it. */
  it('is silent for a round that answers at once', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.read({ type: 'session.input_transcript.delta', delta: 'turn the kitchen light off' });
      h.read({ type: 'session.delegation.created', delegation: { id: 'item_1', target: 'client' } });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]).toMatchObject({ content: 'It is off now.' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('attaching', () => {
  it('is the running session, with the id escaped', () => {
    expect(liveSidebandUrl('sess_123')).toBe(
      'wss://api.openai.com/v1/live/sessions/sess_123/attach',
    );
    expect(liveSidebandUrl('a/b')).toContain('a%2Fb');
  });
});
