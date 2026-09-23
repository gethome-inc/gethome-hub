import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { HubEventBus } from '../src/core/bus.js';
import { ActivityService } from '../src/core/activity.js';
import { AiRunLog } from '../src/core/ai-runs.js';
import { AccessService } from '../src/core/access.js';
import { SettingsService } from '../src/core/settings.js';
import {
  activity as activityTable,
  aiRuns as aiRunsTable,
  devices as devicesTable,
  members as membersTable,
  roles as rolesTable,
} from '../src/db/schema.js';
import { asc, eq } from 'drizzle-orm';
import { openTestDb, resetDb, startedAutomations, type TestDb } from './helpers/db.js';
import { AssistantChat } from '../src/ai/assistant-chat.js';
import { AutomationNotConfiguredError } from '../src/ai/automation-chat.js';
import type { AssistantTurn } from '../src/ai/assistant-agent.js';
import type {
  AgentConversation,
  ChatStepWire,
  ChatTurnContext,
} from '../src/ai/chat/chat-runtime.js';
import { refusalSentence } from '../src/ai/chat/agent-loop.js';
import type { AutomationConversation, AutomationTurn } from '../src/ai/automation-conversation.js';
import type { EngineRegistry } from '../src/automations/engine.js';
import { AGENT_MODELS, effectiveAgentModel } from '../src/ai/models.js';
import { DECISION_MODEL } from '../src/ai/decide/decider.js';
import type { DecisionTransport } from '../src/ai/decide/connection.js';
import { FAMILIES, UNCHANGED } from '../src/ai/decide/questions.js';
import type { SplitInput, SplitResult } from '../src/ai/decide/split.js';

/**
 * The assistant: its conversation service over a stand-in for a provider, and
 * the handoff, which is the one thing here nothing else in the hub does.
 *
 * The seam stands in for the **network, not the rules** — every configuration
 * refusal below is asserted against the real check, because a seam above them
 * is a bypass and a suite that reaches a conversation the real hub would have
 * refused is testing the seam. That trap is why the automations agent's own
 * refusal once shipped untested and reached a phone as a 500.
 */

const log = pino({ level: 'silent' });

/** One request the decision model was sent, as it arrived. */
interface DecisionCall {
  state: unknown;
  questions: string[];
}

/**
 * A decision model that answers each request with whatever a case needs, and
 * a record of what it was asked.
 *
 * It is handed in as the decider's **transport** — the one seam
 * `AssistantChatOptions` has for it — so every rule about what a reading means
 * still runs, and it answers with a real `Response` for `test/ai-decide.
 * test.ts`'s reason: a mock laxer than the thing it stands in for tests the
 * mock. The count is the assertion in several tests below: what the reuse and
 * the one-request fan-out fix is not *what* the hub concludes but how many
 * times it pays to conclude it.
 */
function jev(answer: (call: DecisionCall) => Record<string, unknown>): {
  seen: { calls: DecisionCall[]; warmups: number };
  transport: DecisionTransport;
} {
  const seen = { calls: [] as DecisionCall[], warmups: 0 };
  const transport: DecisionTransport = {
    isWarm: () => false,
    fetch: async (_url, init) => {
      // A warm-up asks for the model list and reads nothing back.
      if (init.method === 'GET') {
        seen.warmups += 1;
        return new Response('{"data":[]}', { status: 200 });
      }
      const body = JSON.parse(String(init.body)) as { state: unknown; questions: Record<string, unknown> };
      const call = { state: body.state, questions: Object.keys(body.questions) };
      seen.calls.push(call);
      return new Response(
        JSON.stringify({ model: DECISION_MODEL, answers: answer(call), usage: { input_tokens: 900 } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-typesafe-request-id': 'req-7' },
        },
      );
    },
  };
  return { seen, transport };
}

/** What one decision costs at 900 input tokens — see `estimateDecisionCostUsd`. */
const DECISION_USD = (900 * 0.042) / 1_000_000;

/** A decider transport for the suites that never set a key: it must never be reached. */
const NO_NETWORK: DecisionTransport = {
  isWarm: () => false,
  fetch: async () => {
    throw new Error('a suite never reaches the decision model');
  },
};

/** Whether a decision request was for the sentence or for the parts it was split into. */
const isParts = (call: DecisionCall): boolean =>
  typeof call.state === 'object' && call.state !== null && 'parts' in call.state;

const noul = (value: number) => ({ type: 'noul', noul: value });

/** Every action family, answered "not this". */
const UNCHANGED_FAMILIES = Object.fromEntries(
  FAMILIES.map((family) => [family, { type: 'choice', choice: UNCHANGED, probabilities: { [UNCHANGED]: 0.97 }, confidence: 0.97 }]),
);

/**
 * Everything a plain "turn off <that device>" answers — under a prefix when it
 * is one part of a split sentence.
 */
function offAnswers(deviceKey = 'd1', prefix = ''): Record<string, unknown> {
  const plain: Record<string, unknown> = {
    intent: sure('device_command', 0.97),
    later: noul(0.2),
    negated: noul(0.2),
    scope: sure('one_device', 0.96),
    place: sure('not_said', 0.9),
    deviceType: sure('lights', 0.9),
    device: sure(deviceKey, 0.95),
    ...UNCHANGED_FAMILIES,
    power: sure('off', 0.96),
    multiple: noul(0.1),
    anyCommand: noul(0.95),
    route: sure('here', 0.99),
    selfContained: noul(0.9),
  };
  return Object.fromEntries(Object.entries(plain).map(([id, value]) => [`${prefix}${id}`, value]));
}

const sure = (choice: string, confidence: number) => ({
  type: 'choice',
  choice,
  probabilities: { [choice]: confidence },
  confidence,
});

/** Two lights a sentence can plausibly mean either of. */
function twoLights(tv: string, ceiling: string): ReturnType<EngineRegistry['listDevices']> {
  return [...oneLight(tv), ...oneLight(ceiling)].map((device, index) => ({
    ...device,
    name: index === 0 ? 'TV light' : 'Ceiling light',
  }));
}

/** One light, which is all a device question needs to be answerable. */
function oneLight(deviceId: string): ReturnType<EngineRegistry['listDevices']> {
  return [
    {
      id: deviceId,
      name: 'Ceiling light',
      roomId: null,
      online: true,
      endpoints: [
        {
          endpointId: 1,
          deviceKind: 'light',
          capabilities: ['onOff'],
          state: { reachable: true, sensors: {}, onOff: true },
        },
      ],
    },
  ];
}
let handle: TestDb | null = null;
const startedEngines: { stop: () => Promise<void> }[] = [];

afterAll(async () => {
  await Promise.allSettled(startedEngines.map((engine) => engine.stop()));
  await handle?.close();
});

describe('the assistant', () => {
  let events: HubEventBus;
  let settings: SettingsService;
  let access: AccessService;
  let activity: ActivityService;
  let memberId: string;
  let commanded: { deviceId: string; endpointId: number; type: string }[];
  /** Every command that reached the registry, refused or not. */
  let attempted: { deviceId: string; endpointId: number; type: string }[];

  let assistantFor: (
    turns: AssistantTurn[],
    options?: {
      cost?: () => number;
      gate?: Promise<void>;
      /** What the *other* agent says, when the test delegates to it. Scripted
       *  for the same reason this one is: a suite must never reach a provider,
       *  and a sub-agent with no seam fails its first round — which is real
       *  behaviour and the wrong thing to be asserting on here. */
      delegated?: AutomationTurn[];
      /** What the registry holds, for the spoken state digest — the one thing
       *  here that reads a device's *values* rather than the home's shape.
       *  The registry's own return type, not a hand-written copy: `deviceKind`
       *  and `capabilities` are closed vocabularies and a widened `string`
       *  makes this the only stub in the file that does not typecheck. */
      devices?: ReturnType<EngineRegistry['listDevices']>;
      /** The decision model's transport. A suite that sets no key never
       *  reaches it, and one that does must say what it answers. */
      decisions?: DecisionTransport;
      /** The generative split of a sentence that is several requests. */
      split?: (input: SplitInput) => Promise<SplitResult | null>;
      /** The adapter's own words for a device that will not take a command. */
      refuse?: (deviceId: string) => string | undefined;
    },
  ) => Promise<{
    assistant: AssistantChat;
    automationChat: Awaited<ReturnType<typeof startedAutomations>>['chat'];
    /** What each round was asked to work at — `undefined` is the
     *  conversation's own setting. See the spoken-effort test. */
    efforts: (string | undefined)[];
    /** What each round was actually *sent*, priming included. The transcript
     *  is what was said; this is what the model read. */
    sent: string[];
  }>;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    handle ??= (await openTestDb())!;
    await resetDb(handle.db);
    events = new HubEventBus();
    settings = new SettingsService(handle.db, Buffer.alloc(32).toString('base64'));
    await settings.setAiKey('anthropic', 'sk-ant-api03-test');
    access = new AccessService(handle.db, events);
    await access.load();
    activity = new ActivityService(handle.db, events);
    commanded = [];
    attempted = [];
    // A real row: `automation_chat_messages.member_id` is a foreign key, and a
    // made-up id makes every transcript write fail silently into its own catch.
    memberId = randomUUID();
    await handle.db.insert(membersTable).values({ id: memberId, name: 'Anna', role: 'owner' });

    assistantFor = async (turns, options) => {
      // The registry is a stand-in, but the activity log's `device_id` is a
      // real foreign key — so the devices it lists are rows as well, as they
      // are on a hub.
      for (const device of options?.devices ?? []) {
        await handle!.db
          .insert(devicesTable)
          .values({ id: device.id, adapter: 'test', externalId: device.id, name: device.name });
      }
      const registry = {
        listDevices: () => options?.devices ?? [],
        execute: async (deviceId: string, endpointId: number, command: { type: string }) => {
          attempted.push({ deviceId, endpointId, type: command.type });
          const refusal = options?.refuse?.(deviceId);
          if (refusal !== undefined) throw new Error(refusal);
          commanded.push({ deviceId, endpointId, type: command.type });
        },
      };
      let delegatedRound = 0;
      const delegatedTurn = async (): Promise<AutomationTurn> => {
        const at = delegatedRound;
        delegatedRound += 1;
        return options?.delegated?.[at] ?? { kind: 'said', text: 'nothing left to say' };
      };
      const scriptedDelegate: AutomationConversation = {
        provider: 'anthropic',
        modelId: 'claude-opus-5',
        effort: 'medium' as const,
        awaitingAnswer: () => false,
        costUsd: () => 0.02,
        send: delegatedTurn,
        answer: delegatedTurn,
      };
      const { engine, chat: automationChat } = await startedAutomations(
        handle!.db,
        events,
        registry,
        activity,
        { settings, createConversation: () => scriptedDelegate },
      );
      startedEngines.push(engine);

      let index = 0;
      const efforts: (string | undefined)[] = [];
      const sent: string[] = [];
      const round = async (text: string, context?: ChatTurnContext): Promise<AssistantTurn> => {
        const at = index;
        index += 1;
        efforts.push(context?.effort);
        sent.push(text);
        context?.onStep?.('Reading your home', 'thinking');
        await options?.gate;
        return turns[at] ?? { kind: 'said', text: 'nothing left to say' };
      };
      const scripted: AgentConversation<AssistantTurn> = {
        provider: 'anthropic',
        modelId: 'claude-opus-5',
        effort: 'medium' as const,
        awaitingAnswer: () => false,
        costUsd: options?.cost ?? (() => 0.04),
        send: round,
        answer: round,
      };
      const assistant = new AssistantChat({
        db: handle!.db,
        settings,
        events,
        runs: new AiRunLog(handle!.db, events),
        log,
        access,
        activity,
        registry,
        engine,
        automationChat,
        createConversation: () => scripted,
        decisionTransport: options?.decisions ?? NO_NETWORK,
        ...(options?.split !== undefined ? { splitRequest: options.split } : {}),
      });
      return { assistant, automationChat, efforts, sent };
    };
  });

  it('answers as soon as the message is taken, and writes the person’s own row', async () => {
    const { assistant } = await assistantFor([{ kind: 'said', text: 'The kitchen light is on.' }]);
    const started = await assistant.start({ memberId, message: 'is the kitchen light on?' });

    // An acknowledgement, not an outcome — the `POST /devices/:id/remap`
    // lesson. Everything the agent says arrives on the socket.
    expect(started.messages.map((message) => message.role)).toEqual(['user']);

    await assistant.idle();
    const rows = await assistant.transcript(started.sessionId);
    expect(rows.map((row) => row.role)).toEqual(['user', 'agent']);
    expect(rows[1]?.text).toBe('The kitchen light is on.');
  });

  /**
   * The hub-side half of client delegation, and the bug it fixed.
   *
   * GPT-Live says "I need help" and nothing else, so the hub's sideband
   * assembles the request from the transcript and asks — through the *ordinary*
   * path, so a spoken exchange leaves exactly what a typed one does. The phone
   * used to write the person's sentence itself **and** send it as a message, so
   * every spoken request landed in the transcript twice; the row count is what
   * pins that.
   *
   * And it **waits**, where the phone could only acknowledge and subscribe: the
   * conversation's own `inFlight` is the answer, which is why the caller gets a
   * string back rather than a continuation to resume.
   */
  it('asks the home out loud, waits for the answer, and writes one row each', async () => {
    const { assistant } = await assistantFor([
      { kind: 'said', text: 'The kitchen light is off now.' },
    ]);
    const sessionId = assistant.beginVoice();

    const answer = await assistant.askAloud({
      sessionId,
      memberId,
      question: 'turn the kitchen light off',
    });
    expect(answer).toBe('The kitchen light is off now.');

    const rows = await assistant.transcript(sessionId);
    expect(rows.map((row) => row.role)).toEqual(['user', 'agent']);
    expect(rows[0]?.text).toBe('turn the kitchen light off');
  });

  /**
   * **Somebody else's conversation is not one to speak into**, which is the
   * guard `revive()` has always held for a typed message and which the spoken
   * path fell straight past.
   *
   * `askAloud` resolves a session three ways: one this process holds, one
   * revived from its rows, and — for the id `beginVoice` just minted — a fresh
   * one opened under that id. Only the third refuses nothing, so a session id
   * belonging to another member reached it and the round wrote into *their*
   * transcript. Reading a home's transcripts is shared by design; writing into
   * one is not.
   */
  it('refuses to speak into a conversation that belongs to somebody else', async () => {
    const { assistant } = await assistantFor([{ kind: 'said', text: 'The kitchen light is off.' }]);
    const sessionId = assistant.beginVoice();
    await assistant.askAloud({ sessionId, memberId, question: 'turn the kitchen light off' });

    const otherId = randomUUID();
    await handle!.db.insert(membersTable).values({ id: otherId, name: 'Kolya', role: 'member' });

    const answer = await assistant.askAloud({
      sessionId,
      memberId: otherId,
      question: 'what did she ask you?',
    });
    expect(answer).toBeNull();
    // And nothing of theirs was written into it.
    const rows = await assistant.transcript(sessionId);
    expect(rows.map((row) => row.role)).toEqual(['user', 'agent']);
    expect(await assistant.maySpeakInto(sessionId, otherId)).toBe(false);
    expect(await assistant.maySpeakInto(sessionId, memberId)).toBe(true);
    // A conversation nobody has said anything in yet is anybody's to open,
    // which is the ordinary case: the app mints an id and the hub writes the
    // first row.
    expect(await assistant.maySpeakInto(randomUUID(), otherId)).toBe(true);
  });

  /**
   * A second question reaches the same conversation, which is what makes a
   * spoken exchange continuable — by speaking again, and by typing afterwards.
   */
  it('carries one spoken conversation on across questions', async () => {
    const { assistant } = await assistantFor([
      { kind: 'said', text: 'It is off.' },
      { kind: 'said', text: 'The hall one is off too.' },
    ]);
    const sessionId = assistant.beginVoice();

    await assistant.askAloud({ sessionId, memberId, question: 'turn the kitchen light off' });
    const second = await assistant.askAloud({ sessionId, memberId, question: 'and the hall' });

    expect(second).toBe('The hall one is off too.');
    const rows = await assistant.transcript(sessionId);
    expect(rows.map((row) => row.role)).toEqual(['user', 'agent', 'user', 'agent']);
  });

  /**
   * **A question is an answer, and skipping it said the opposite.**
   *
   * `askAloud` took `agent` and `note` rows only, which covers the two arms a
   * typed reply usually ends in and silently drops the third — and `ask_user`
   * is precisely the tool the assistant's own prompt sends it to when a
   * request is ambiguous in a way that changes what it would *do*, which is
   * the commonest thing to be ambiguous about out loud. The scan fell off the
   * end and returned `null`, the sideband answered that with *"that could not
   * be worked out"*, and somebody who had just asked for a light to be turned
   * off heard a refusal while a perfectly good question with two tappable
   * options landed on a page in their pocket.
   *
   * The options are spoken with it, because the model writes the choices into
   * `options` and leaves the question bare — "Which one?" is not answerable in
   * a room.
   */
  it('reads the agent’s question out loud, with the options it offered', async () => {
    const { assistant } = await assistantFor([
      {
        kind: 'question',
        question: {
          question: 'Which light?',
          options: [
            { id: 'ceiling', label: 'the ceiling light' },
            { id: 'lamp', label: 'the lamp by the sofa' },
          ],
        },
      },
    ]);
    const sessionId = assistant.beginVoice();

    const spoken = await assistant.askAloud({
      sessionId,
      memberId,
      question: 'turn the light off',
    });
    expect(spoken).toBe('Which light? the ceiling light or the lamp by the sofa?');

    // The row an app draws is untouched — tappable options and all.
    const rows = await assistant.transcript(sessionId);
    expect(rows.map((row) => row.role)).toEqual(['user', 'question']);
    expect(rows[1]?.text).toBe('Which light?');
  });

  /** A question with nothing to offer is simply itself. */
  it('speaks a bare question as it stands', async () => {
    const { assistant } = await assistantFor([
      { kind: 'question', question: { question: 'Which room did you mean?' } },
    ]);
    const sessionId = assistant.beginVoice();
    expect(await assistant.askAloud({ sessionId, memberId, question: 'turn it off' })).toBe(
      'Which room did you mean?',
    );
  });

  /**
   * **The backend has to know it is being spoken to, and the person must not
   * see it being told.**
   *
   * The system prompt carries two sets of writing rules — a three-inch phone
   * column, and the ear — because it is byte-identical for the life of a build
   * and free after the first round; this line is the marker that picks the
   * second. Without it a spoken answer was written for the column and read out
   * with its bullets and asterisks in it, which is exactly what OpenAI's
   * delegation guide means by keeping Markdown meant for display in the
   * backend.
   *
   * It rides on `ChatSession.priming`, so it reaches the model and is **not**
   * written down: the row this turn writes is what the person actually said,
   * and an instruction stapled to the front of it would be read back on the
   * page and carried into every later round as something they had said.
   */
  it('tells a spoken round that it is spoken, and writes down only what was said', async () => {
    const { assistant, sent } = await assistantFor([{ kind: 'said', text: 'It is off.' }]);
    const sessionId = assistant.beginVoice();

    await assistant.askAloud({ sessionId, memberId, question: 'turn the kitchen light off' });

    expect(sent[0]).toContain('spoken aloud');
    expect(sent[0]).toContain('turn the kitchen light off');

    const rows = await assistant.transcript(sessionId);
    expect(rows[0]?.text).toBe('turn the kitchen light off');
  });

  /**
   * **What everything is doing right now, which the cached first message
   * cannot carry.**
   *
   * The home goes into the first user message because a round spent asking
   * "what devices do you have" is a round somebody watched go past — and live
   * *values* were the deliberate exception, since that message is written once
   * and would be answered from confidently an hour later. Out loud that
   * exception costs a whole model round: "is the kitchen light on" was one
   * round to call `get_device` and a second to say the answer, on the class of
   * question that is most of what anybody asks a house. Built at the moment of
   * the turn, so there is nothing to go stale, and on `priming`, so it reaches
   * the model and never the transcript or the cached first message.
   */
  it('tells a spoken round what everything is doing right now', async () => {
    const deviceId = randomUUID();
    const { assistant, sent } = await assistantFor([{ kind: 'said', text: 'It is on.' }], {
      devices: [
        {
          id: deviceId,
          name: 'Ceiling light',
          roomId: null,
          online: true,
          endpoints: [
            {
              endpointId: 1,
              deviceKind: 'light',
              capabilities: ['onOff'],
              state: { reachable: true, sensors: {}, onOff: true },
            },
          ],
        },
      ],
    });
    const sessionId = assistant.beginVoice();

    await assistant.askAloud({ sessionId, memberId, question: 'is the ceiling light on?' });

    expect(sent[0]).toContain('WHAT EVERY DEVICE IS DOING RIGHT NOW');
    expect(sent[0]).toContain('"onOff":true');
    expect(sent[0]).toContain(deviceId);

    // And not into the transcript, which is what the person actually said.
    const rows = await assistant.transcript(sessionId);
    expect(rows[0]?.text).toBe('is the ceiling light on?');
  });

  /** A home with nothing reporting anything grows no section, rather than a
   *  heading over an empty list. */
  it('says nothing about state in a home with none', async () => {
    const { assistant, sent } = await assistantFor([{ kind: 'said', text: 'It is off.' }]);
    const sessionId = assistant.beginVoice();
    await assistant.askAloud({ sessionId, memberId, question: 'turn the kitchen light off' });
    expect(sent[0]).not.toContain('WHAT EVERY DEVICE IS DOING RIGHT NOW');
  });

  /** And a typed round in the same conversation is told nothing of the sort —
   *  the marker is per turn, like the effort beside it. */
  it('leaves a typed round unmarked', async () => {
    const { assistant, sent } = await assistantFor([
      { kind: 'said', text: 'It is off.' },
      { kind: 'said', text: 'So is the hall.' },
    ]);
    const sessionId = assistant.beginVoice();

    await assistant.askAloud({ sessionId, memberId, question: 'turn the kitchen light off' });
    await assistant.reply(sessionId, memberId, 'and the hall one?');
    await assistant.idle();

    expect(sent[0]).toContain('spoken aloud');
    expect(sent[1]).not.toContain('spoken aloud');
  });

  /**
   * **The same conversation, two speeds.** A spoken round is a person standing
   * in a room waiting for an answer, and a typed one is a message they read
   * when it lands — so the turn asks for `low` out loud and leaves a typed
   * round on the conversation's own `medium`. Per *turn* is the whole point:
   * this asserts both against one session, because a transport is built once
   * and a conversation typed in the morning is talked to in the evening.
   */
  it('thinks less when the answer is spoken, and only then', async () => {
    const { assistant, efforts } = await assistantFor([
      { kind: 'said', text: 'It is off.' },
      { kind: 'said', text: 'Both are off.' },
    ]);
    const sessionId = assistant.beginVoice();

    await assistant.askAloud({ sessionId, memberId, question: 'turn the kitchen light off' });
    expect(efforts).toEqual(['low']);

    // The same conversation, carried on by typing.
    await assistant.reply(sessionId, memberId, 'and the hall one?');
    await assistant.idle();
    expect(efforts).toEqual(['low', undefined]);
  });

  /**
   * **The ledger says what ran, not what is configured now.**
   *
   * `kind` cannot tell a spoken round from a typed one — both are `assist` —
   * and those are exactly the two that behave differently: one answered at a
   * lower effort with a per-second meter running beside it. Reading a slow
   * answer back next week without either field leaves the only question worth
   * asking unanswerable.
   */
  it('writes down what each turn ran at and how it was asked', async () => {
    // A turn's row is its *delta*, so a conversation whose cost never moves
    // writes one row however many rounds it runs — see `record`.
    let spent = 0.04;
    const { assistant } = await assistantFor(
      [
        { kind: 'said', text: 'It is off.' },
        { kind: 'said', text: 'Both are off.' },
      ],
      { cost: () => spent },
    );
    const sessionId = assistant.beginVoice();

    await assistant.askAloud({ sessionId, memberId, question: 'turn the kitchen light off' });
    spent = 0.07;
    await assistant.reply(sessionId, memberId, 'and the hall one?');
    await assistant.idle();

    const rows = await handle!.db
      .select()
      .from(aiRunsTable)
      .orderBy(asc(aiRunsTable.at));
    expect(rows.map((row) => [row.kind, row.effort, row.via])).toEqual([
      ['assist', 'low', 'voice'],
      // The conversation's own effort, read back rather than re-derived.
      ['assist', 'medium', 'typed'],
    ]);
  });

  /**
   * The meter on the line is not a generation: GPT-Live has no effort setting,
   * and a number invented here would be the one field in this log that was
   * never true of anything.
   */
  it('marks the voice meter as spoken and gives it no effort', async () => {
    const { assistant } = await assistantFor([]);
    const sessionId = assistant.beginVoice();
    await assistant.recordVoiceSpend({ sessionId, seconds: 90 });

    const rows = await handle!.db.select().from(aiRunsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('voice');
    expect(rows[0]?.via).toBe('voice');
    expect(rows[0]?.effort).toBeNull();
  });

  it('keeps its conversations apart from the automations agent’s', async () => {
    const { assistant, automationChat } = await assistantFor([
      { kind: 'said', text: 'Hello.' },
    ]);
    const mine = await assistant.start({ memberId, message: 'hello' });
    await assistant.idle();

    // A row written before the `surface` column existed is an automations row,
    // so the automations list has to be the one that reads null as its own.
    const listed = await assistant.list();
    expect(listed.map((entry) => entry.sessionId)).toEqual([mine.sessionId]);
    expect((await automationChat.list()).map((entry) => entry.sessionId)).toEqual([]);
  });

  it('refuses before it reaches the seam, with a code an app can branch on', async () => {
    const { assistant } = await assistantFor([]);

    await settings.setAiEnabled(false);
    await expect(assistant.start({ memberId, message: 'go' })).rejects.toBeInstanceOf(
      AutomationNotConfiguredError,
    );
    await expect(assistant.start({ memberId, message: 'go' })).rejects.toMatchObject({
      code: 'ai_disabled',
    });

    await settings.setAiEnabled(true);
    await settings.clearAiCredential('anthropic');
    await expect(assistant.start({ memberId, message: 'go' })).rejects.toMatchObject({
      code: 'ai_not_configured',
    });
  });

  it('runs the model the settings route reports, and moves with the offered list', async () => {
    const both = { anthropic: true, openai: true };
    // The gap that cost the mapper a release: every surface that *reported* a
    // model went through `effectiveModel` while the call that picked one to
    // run read the stored column.
    expect(effectiveAgentModel(null, both)).toEqual({
      provider: 'anthropic',
      modelId: AGENT_MODELS.anthropic.default,
    });
    expect(effectiveAgentModel('claude-sonnet-5', both)).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet-5',
    });
    // A model this build no longer offers is stored happily and is simply not
    // what runs — silently keeping a home on a retired one is the failure. The
    // *provider* survives it, off `PRICING`: the vendor was a real choice and
    // the retired id was not.
    expect(effectiveAgentModel('claude-opus-4-6', both)).toEqual({
      provider: 'anthropic',
      modelId: AGENT_MODELS.anthropic.default,
    });

    await settings.setAssistantModel('claude-sonnet-5');
    expect((await settings.getAiSettings()).assistant.model).toBe('claude-sonnet-5');
  });

  it('runs on the key the home actually has, whatever model is stored', async () => {
    /**
     * The half a list-only resolution gets wrong, and the reason this is
     * key-aware at all. A home that has only ever had an OpenAI key still has
     * `claude-opus-5` stored — it is the default, and nobody chose it — so
     * resolving on the offered list alone points every conversation at a vendor
     * the hub cannot authenticate to and answers `ai_not_configured` on a home
     * that is configured.
     */
    const onlyOpenAi = { anthropic: false, openai: true };
    expect(effectiveAgentModel('claude-opus-5', onlyOpenAi)).toEqual({
      provider: 'openai',
      modelId: AGENT_MODELS.openai.default,
    });
    // And a deliberate OpenAI choice is kept, rather than being read as a
    // fallback and moved to that provider's default.
    expect(effectiveAgentModel('gpt-5.6-terra', onlyOpenAi)).toEqual({
      provider: 'openai',
      modelId: 'gpt-5.6-terra',
    });
    // Neither key is the only case with no answer — the caller refuses on it.
    expect(effectiveAgentModel('claude-opus-5', { anthropic: false, openai: false })).toBeNull();

    // End to end: the same home, through the settings route both agents read.
    await settings.setAiKey('openai', 'sk-proj-test');
    await settings.clearAiCredential('anthropic');
    const ai = await settings.getAiSettings();
    expect(ai.assistant.provider).toBe('openai');
    expect(ai.automations.provider).toBe('openai');
    expect(AGENT_MODELS.openai.choices.map((choice) => choice.id)).toContain(ai.assistant.model);
  });

  it('lets the two agents choose their model apart, and the mapper choose neither', async () => {
    // One list, a column each: answering questions about the house and writing
    // the rules it runs by itself are different jobs, and a home may want to
    // spend differently on them.
    await settings.setAssistantModel('claude-sonnet-5');
    await settings.setAutomationsModel('claude-opus-5');
    let ai = await settings.getAiSettings();
    expect([ai.assistant.model, ai.automations.model]).toEqual([
      'claude-sonnet-5',
      'claude-opus-5',
    ]);

    await settings.setAutomationsModel('claude-sonnet-5');
    ai = await settings.getAiSettings();
    // Moving one leaves the other exactly where it was — which the automations
    // agent could not have said before, because it read the *mapper's* column.
    expect(ai.automations.model).toBe('claude-sonnet-5');
    expect(ai.assistant.model).toBe('claude-sonnet-5');

    // And the mapper's own choice reaches neither, in either direction: a
    // descriptor is cached against a device model for ever, which is why that
    // list offers one model and this one offers two.
    await settings.setAiModel('claude-opus-5', 'anthropic');
    await settings.setAssistantModel(null);
    ai = await settings.getAiSettings();
    expect(ai.anthropic.model).toBe('claude-opus-5');
    expect(ai.assistant.model).toBe(AGENT_MODELS.anthropic.default);
    expect(ai.automations.model).toBe('claude-sonnet-5');
  });

  it('says which class of refusal it was, where the category is one a home can trip', async () => {
    // `stop_details` is informational and is null on plenty of real refusals,
    // so `stop_reason` decides *that* a round was refused and this decides only
    // the sentence — a category the build has never met, and a null one, both
    // keep the generic wording rather than falling through to nothing.
    expect(refusalSentence('reasoning_extraction')).toContain('my own reasoning');
    expect(refusalSentence('cyber')).toContain('security work');
    expect(refusalSentence(null)).toBe(
      'The model declined to answer that. Try asking for it differently.',
    );
    // OpenAI reports no category at all, so this is the branch every refusal
    // on that provider takes — a valid permanent state rather than a gap.
    expect(refusalSentence(undefined)).toBe(
      'The model declined to answer that. Try asking for it differently.',
    );
  });

  it('works a device through the registry and names the person in the log', async () => {
    const { assistant } = await assistantFor([{ kind: 'said', text: 'Done.' }]);
    const started = await assistant.start({ memberId, message: 'lights on' });
    await assistant.idle();

    // The tool context is what the agent is handed; the scripted conversation
    // never calls it, so this exercises the same path the loop would.
    const tools = (
      assistant as unknown as {
        toolContext: (id: string, sessionId: string) => { control: (...args: never[]) => Promise<void> };
      }
    ).toolContext(memberId, started.sessionId);
    const deviceId = randomUUID();
    await (tools.control as unknown as (
      d: string,
      e: number,
      c: { type: string },
    ) => Promise<void>)(deviceId, 1, { type: 'power' });

    expect(commanded).toEqual([{ deviceId, endpointId: 1, type: 'power' }]);
    const rows = await handle!.db.select().from(activityTable);
    const command = rows.find((row) => row.kind === 'device.command');
    // Named for the person who asked, not for the agent: the feed is read a
    // week later, and "the assistant" is not somebody anyone can go and ask.
    expect(command?.message).toContain('Anna');
    expect((command?.data as { via?: string } | null)?.via).toBe('assistant');
    expect(started.sessionId).toBeTruthy();
  });

  // ── The handoff ────────────────────────────────────────────────────────────

  it('hands a job over without waiting for it, and says so on a card', async () => {
    // The other agent's conversation, started the way `delegate` starts one:
    // the brief is the first thing said in it, and starting it returns before
    // it has done anything.
    const { assistant, automationChat } = await assistantFor([]);
    const brief = 'switch the hall lamp on at sunset';
    const tools = (
      assistant as unknown as {
        toolContext: (
          id: string,
          sessionId: string,
        ) => {
          delegate: (
            agent: string,
            brief: string,
            fresh?: boolean,
          ) => Promise<{ sessionId: string; refused?: string }>;
        };
      }
      // No conversation of its own here: this drives the tool directly, and
      // "what did *this* chat hand over before" has no answer for a chat that
      // does not exist — which is the same as never having handed anything
      // over, and so a fresh conversation.
    ).toolContext(memberId, randomUUID());

    // **The whole contract in one line: this returns before the other agent
    // has done anything.** A `delegate` that awaited the sub-agent's turn
    // would put its whole round — minutes of it — inside the assistant's, and
    // its transcript inside the assistant's context.
    const handed = await tools.delegate('automations', brief);
    expect(handed.refused).toBeUndefined();
    expect((await automationChat.transcript(handed.sessionId))[0]?.text).toBe(brief);

    // And the card the app draws, through the ordinary turn path: a `handoff`
    // row naming the session to follow, so the trail, the questions and the
    // rules are read from the sub-agent's own transcript rather than copied
    // into this one.
    const { assistant: second } = await assistantFor([
      {
        kind: 'handed',
        text: 'Handed that to the automations agent.',
        handoffs: [{ agent: 'automations', brief, sessionId: handed.sessionId }],
      },
    ]);
    const started = await second.start({ memberId, message: 'sunset lamp please' });
    await second.idle();

    const rows = await second.transcript(started.sessionId);
    expect(rows.map((row) => row.role)).toEqual(['user', 'agent', 'handoff']);
    const card = rows[2]?.data as { sessionId: string; status: string; title: string };
    expect(card.sessionId).toBe(handed.sessionId);
    expect(card.title).toBe('Automations agent');
    // `working`, because the other agent has been given the job and has not
    // come back with anything yet. What moves it is that agent's own `turn`
    // frame, never a second round with this one.
    expect(card.status).toBe('working');
  });

  it('moves the card as the other agent gets on with it, without a second round', async () => {
    const brief = 'switch the hall lamp on at sunset';
    const document = {
      version: 1,
      name: 'Hall lamp at sunset',
      mode: 'single',
      triggers: [{ kind: 'manual' }],
      actions: [{ kind: 'logActivity', message: 'Sunset' }],
    };
    const { assistant, automationChat } = await assistantFor([], {
      delegated: [
        {
          kind: 'question',
          question: { question: 'Which hall lamp?', options: [{ id: 'a', label: 'The tall one' }] },
        },
        { kind: 'submitted', rules: [{ document, replaces: null }], text: 'Written.' },
      ],
    });
    const tools = (
      assistant as unknown as {
        toolContext: (
          id: string,
          sessionId: string,
        ) => {
          delegate: (agent: string, brief: string, fresh?: boolean) => Promise<{ sessionId: string }>;
        };
      }
    ).toolContext(memberId, randomUUID());
    const handed = await tools.delegate('automations', brief);
    await automationChat.idle();

    const { assistant: second } = await assistantFor([
      {
        kind: 'handed',
        text: 'Handed that over.',
        handoffs: [{ agent: 'automations', brief, sessionId: handed.sessionId }],
      },
    ]);
    const started = await second.start({ memberId, message: 'sunset lamp please' });
    await second.idle();

    const card = async () =>
      (await second.transcript(started.sessionId)).find((row) => row.role === 'handoff')?.data as
        | { status: string; automationIds: string[] }
        | undefined;

    // It asked something, and its own `turn` frame is what said so. **No
    // second round with the assistant's model**: the status is read off that
    // conversation's transcript and written onto the row.
    expect((await card())?.status).toBe('asked');

    // Answered, it writes the rule — and the card says which one, so the app
    // can draw it without asking anything else.
    await automationChat.reply(handed.sessionId, memberId, 'the tall one');
    await automationChat.idle();
    const delivered = await card();
    expect(delivered?.status).toBe('delivered');
    expect(delivered?.automationIds).toHaveLength(1);

    // And the assistant was never asked anything to work that out: its own
    // transcript is exactly what its one turn wrote.
    expect((await second.transcript(started.sessionId)).map((row) => row.role)).toEqual([
      'user',
      'agent',
      'handoff',
    ]);
  });

  it('says the card moved on its own conversation, and not as a round ending', async () => {
    const brief = 'switch the hall lamp on at sunset';
    const { assistant, automationChat } = await assistantFor([], {
      delegated: [
        {
          kind: 'question',
          question: { question: 'Which hall lamp?', options: [{ id: 'a', label: 'The tall one' }] },
        },
      ],
    });
    const tools = (
      assistant as unknown as {
        toolContext: (id: string, sessionId: string) => {
          delegate: (agent: string, brief: string) => Promise<{ sessionId: string }>;
        };
      }
    ).toolContext(memberId, randomUUID());
    const handed = await tools.delegate('automations', brief);
    await automationChat.idle();

    const { assistant: second } = await assistantFor([
      {
        kind: 'handed',
        text: 'Handed that over.',
        handoffs: [{ agent: 'automations', brief, sessionId: handed.sessionId }],
      },
    ]);
    const started = await second.start({ memberId, message: 'sunset lamp please' });
    await second.idle();

    const frames: { sessionId: string; phase: string }[] = [];
    events.on('assistantChat', (event) => {
      frames.push({ sessionId: event.sessionId, phase: event.phase });
    });

    // The other agent moves, which is what changes the card.
    await automationChat.reply(handed.sessionId, memberId, 'the tall one');
    await automationChat.idle();

    // **Waited for rather than assumed present.** Following the other agent is
    // deliberately not awaited by anything — it hangs off its `turn` frame and
    // reads that conversation's rows — so `idle()` on the delegated chat says
    // nothing about whether this has happened yet.
    const moved: { sessionId: string; phase: string }[] = [];
    await vi.waitFor(() => {
      moved.splice(0, moved.length, ...frames.filter((frame) => frame.phase === 'amend'));
      expect(moved).toHaveLength(1);
    });
    // **This** conversation, because the card is on this transcript. Under the
    // delegated session's id an app re-read the chat where nothing had changed
    // and left the card on "working" until the page was closed and reopened.
    expect(moved[0]?.sessionId).toBe(started.sessionId);
    // And never as `turn`: this can land while somebody is mid-round here, and
    // "a round finished" would take that round's trail down with it.
    expect(frames.some((frame) => frame.phase === 'turn')).toBe(false);
  });

  it('gives a follow-up back to the conversation that already has the job', async () => {
    const brief = 'switch the hall lamp on at sunset';
    const { assistant, automationChat } = await assistantFor([
      {
        kind: 'handed',
        text: 'On it.',
        handoffs: [],
      },
    ]);
    const first = await automationChat.start({ memberId, message: brief });
    await automationChat.idle();

    // A conversation of this agent's that has genuinely handed that job over —
    // the row is what `delegate` reads back, so it has to be a real one.
    const { assistant: talking } = await assistantFor([
      {
        kind: 'handed',
        text: 'Handed that over.',
        handoffs: [{ agent: 'automations', brief, sessionId: first.sessionId }],
      },
    ]);
    const chat = await talking.start({ memberId, message: 'sunset lamp please' });
    await talking.idle();

    const tools = (
      talking as unknown as {
        toolContext: (id: string, sessionId: string) => {
          delegate: (agent: string, brief: string, fresh?: boolean) => Promise<{ sessionId: string }>;
        };
      }
    ).toolContext(memberId, chat.sessionId);

    const again = await tools.delegate('automations', 'make it 11:30 instead');
    await automationChat.idle();
    // The same conversation, so it still has everything it learned — where a
    // fresh one would have met "make it 11:30 instead" with no idea what "it"
    // was, and paid to read the home again to find out.
    expect(again.sessionId).toBe(first.sessionId);
    expect((await automationChat.transcript(first.sessionId)).map((row) => row.text)).toContain(
      'make it 11:30 instead',
    );

    // And a job that genuinely starts over says so.
    const unrelated = await tools.delegate('automations', 'something else entirely', true);
    await automationChat.idle();
    expect(unrelated.sessionId).not.toBe(first.sessionId);
  });

  it('gives a follow-up card its own standing, not the last job’s', async () => {
    const brief = 'switch the hall lamp on at sunset';
    const document = {
      version: 1,
      name: 'Hall lamp at sunset',
      mode: 'single',
      triggers: [{ kind: 'manual' }],
      actions: [{ kind: 'logActivity', message: 'Sunset' }],
    };
    const { assistant, automationChat } = await assistantFor([], {
      delegated: [{ kind: 'submitted', rules: [{ document, replaces: null }], text: 'Written.' }],
    });
    const first = await automationChat.start({ memberId, message: brief });
    await automationChat.idle();

    const { assistant: talking } = await assistantFor([
      {
        kind: 'handed',
        text: 'Handed that over.',
        handoffs: [{ agent: 'automations', brief, sessionId: first.sessionId }],
      },
      {
        kind: 'handed',
        text: 'Passed that on.',
        handoffs: [{ agent: 'automations', brief: 'make it 11:30', sessionId: first.sessionId }],
      },
    ]);
    const chat = await talking.start({ memberId, message: 'sunset lamp please' });
    await talking.idle();

    // The follow-up for real: the tool sends the brief to the conversation
    // that already has the job, which is what puts a fresh `user` row in it —
    // and so what tells the second job apart from the first.
    const tools = (
      talking as unknown as {
        toolContext: (id: string, sessionId: string) => {
          delegate: (agent: string, brief: string) => Promise<{ sessionId: string }>;
        };
      }
    ).toolContext(memberId, chat.sessionId);
    await tools.delegate('automations', 'make it 11:30');
    await automationChat.idle();
    await talking.reply(chat.sessionId, memberId, 'actually 11:30');
    await talking.idle();

    const cards = (await talking.transcript(chat.sessionId))
      .filter((row) => row.role === 'handoff')
      .map((row) => row.data as { status: string; automationIds: string[] });
    expect(cards).toHaveLength(2);
    // The first job did deliver a rule.
    expect(cards[0]?.status).toBe('delivered');
    // The second has only just been asked, and reading the conversation whole
    // it was born saying "delivered" over the first job's rule — and then
    // never moved, because nothing about that had changed since.
    expect(cards[1]?.status).toBe('working');
    expect(cards[1]?.automationIds).toEqual([]);
  });

  it('starts a fresh conversation when this chat has handed that agent nothing', async () => {
    const { assistant, automationChat } = await assistantFor([{ kind: 'said', text: 'Hello.' }]);
    const chat = await assistant.start({ memberId, message: 'hello' });
    await assistant.idle();

    const tools = (
      assistant as unknown as {
        toolContext: (id: string, sessionId: string) => {
          delegate: (agent: string, brief: string) => Promise<{ sessionId: string }>;
        };
      }
    ).toolContext(memberId, chat.sessionId);

    const handed = await tools.delegate('automations', 'switch the hall lamp on at sunset');
    await automationChat.idle();
    expect((await automationChat.transcript(handed.sessionId))[0]?.text).toBe(
      'switch the hall lamp on at sunset',
    );
  });

  // ── The fast path: Jev reads the sentence before the model is asked ───────

  /**
   * **This is the whole latency argument, end to end.** "Turn off the ceiling
   * light" used to cost two model rounds — one to call the tool, one to say it
   * happened. With a decision model in front, the light goes off before the
   * model has been asked anything, and the one round left writes the reply
   * from an exact account of what was done, at the lowest effort, since what
   * is left is a sentence.
   */
  it('carries out a plain command first, and tells the model exactly what was done', async () => {
    const light = randomUUID();
    await settings.setAiKey('typesafe', 'ts-test-key');
    const decisions = jev(() => offAnswers('d1'));
    const info = vi.spyOn(log, 'info');
    const { assistant, sent, efforts } = await assistantFor(
      [{ kind: 'said', text: 'The ceiling light is off.' }],
      { devices: oneLight(light), decisions: decisions.transport },
    );

    const started = await assistant.start({ memberId, message: 'turn off the ceiling light' });
    await assistant.idle();

    // One request, one command, through the registry.
    expect(decisions.seen.calls).toHaveLength(1);
    expect(decisions.seen.calls[0]?.state).toEqual({ said: 'turn off the ceiling light' });
    expect(commanded).toEqual([{ deviceId: light, endpointId: 1, type: 'power' }]);

    // The model is told what happened, in words, and still reads their sentence.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('ALREADY DONE BEFORE YOU WERE ASKED');
    expect(sent[0]).toContain('- Ceiling light: switched off.');
    expect(sent[0]).toContain('Nothing else in their message needs doing.');
    expect(sent[0]).toContain('Do not call a tool to do any of it again');
    expect(sent[0]?.endsWith('turn off the ceiling light')).toBe(true);
    expect(efforts).toEqual(['low']);

    // The transcript is what they said and what the model answered — the
    // account it was given is not a message.
    const rows = await assistant.transcript(started.sessionId);
    expect(rows.map((row) => [row.role, row.text])).toEqual([
      ['user', 'turn off the ceiling light'],
      ['agent', 'The ceiling light is off.'],
    ]);
    const steps = (rows[1]?.data as { steps: ChatStepWire[] }).steps;
    expect(steps[0]).toEqual({
      text: 'Jev switched off Ceiling light',
      kind: 'routing',
      detail: expect.stringMatching(/^\d+ ms, new connection · confidence 0\.95$/),
    });
    expect(steps[1]?.text).toBe('Reading your home');

    // In the log beside every stand-down, so `grep Jev` tells the whole story.
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        jev: expect.objectContaining({ devices: [{ device: 'Ceiling light', commands: ['power'] }] }),
        via: 'typed',
      }),
      'Jev carried out — switched off Ceiling light',
    );
    info.mockRestore();

    // Into the activity log named for the person, like any other command.
    const activityRows = await handle!.db.select().from(activityTable);
    const command = activityRows.find((row) => row.kind === 'device.command');
    expect(command?.message).toBe('Anna · Ceiling light: power');
    expect((command?.data as { via?: string } | null)?.via).toBe('assistant');

    // And banked with the round it preceded, never as a row of its own.
    const runs = await handle!.db.select().from(aiRunsTable);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.costUsd).toBeCloseTo(0.04 + DECISION_USD, 9);
  });

  it('does not switch a lamp twice when the model calls the tool anyway', async () => {
    // The model is told it is done, and a prompt is a request rather than a
    // guarantee. The record of what this turn did is what enforces it.
    const light = randomUUID();
    await settings.setAiKey('typesafe', 'ts-test-key');
    const decisions = jev(() => offAnswers('d1'));
    const { assistant } = await assistantFor([{ kind: 'said', text: 'Off.' }], {
      devices: oneLight(light),
      decisions: decisions.transport,
    });
    const started = await assistant.start({ memberId, message: 'turn off the ceiling light' });
    await assistant.idle();

    const tools = (
      assistant as unknown as {
        toolContext: (
          id: string,
          sessionId: string,
        ) => { control: (deviceId: string, endpointId: number, command: object) => Promise<void> };
      }
    ).toolContext(memberId, started.sessionId);
    await tools.control(light, 1, { type: 'power', on: false });
    expect(attempted).toHaveLength(1);
    // A different command is a person changing their mind, and goes through.
    await tools.control(light, 1, { type: 'power', on: true });
    expect(attempted).toHaveLength(2);
  });

  it('says what a device would not take, and lets it be tried again', async () => {
    const light = randomUUID();
    await settings.setAiKey('typesafe', 'ts-test-key');
    const decisions = jev(() => offAnswers('d1'));
    const { assistant, sent, efforts } = await assistantFor([{ kind: 'said', text: 'It did not answer.' }], {
      devices: oneLight(light),
      decisions: decisions.transport,
      refuse: () => 'the light did not answer',
    });

    const started = await assistant.start({ memberId, message: 'turn off the ceiling light' });
    await assistant.idle();

    expect(commanded).toEqual([]);
    expect(sent[0]).toContain(
      '- Ceiling light: NOT done — it was to be switched off, and the hub could not: the light did not answer',
    );
    expect(sent[0]).toContain('say plainly what could not be done');
    expect(efforts).toEqual(['low']);
    const rows = await assistant.transcript(started.sessionId);
    const steps = (rows[1]?.data as { steps: ChatStepWire[] }).steps;
    expect(steps[0]).toMatchObject({
      text: "Jev couldn't get Ceiling light to do it",
      kind: 'routing',
      detail: expect.stringContaining('failed: the light did not answer'),
    });

    // A command that was refused was never carried out, so asking again is a
    // real second try rather than a silent success over a lamp still on.
    const tools = (
      assistant as unknown as {
        toolContext: (
          id: string,
          sessionId: string,
        ) => { control: (deviceId: string, endpointId: number, command: object) => Promise<void> };
      }
    ).toolContext(memberId, started.sessionId);
    await expect(tools.control(light, 1, { type: 'power', on: false })).rejects.toThrow('did not answer');
    expect(attempted).toHaveLength(2);
  });

  it('does not report a command as failed because the activity log could not take its row', async () => {
    // The lamp has gone off by the time the row is written. A write that
    // fails there is bookkeeping, and it once told the model — and so the
    // person — that a light which had just gone off had not.
    const light = randomUUID();
    await settings.setAiKey('typesafe', 'ts-test-key');
    const decisions = jev(() => offAnswers('d1'));
    const warn = vi.spyOn(log, 'warn');
    const { assistant, sent } = await assistantFor([{ kind: 'said', text: 'Off.' }], {
      devices: oneLight(light),
      decisions: decisions.transport,
    });
    // Gone from the store a moment ago, so the row's foreign key refuses it.
    await handle!.db.delete(devicesTable).where(eq(devicesTable.id, light));

    await assistant.start({ memberId, message: 'turn off the ceiling light' });
    await assistant.idle();

    expect(commanded).toEqual([{ deviceId: light, endpointId: 1, type: 'power' }]);
    expect(sent[0]).toContain('- Ceiling light: switched off.');
    expect(sent[0]).not.toContain('NOT done');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: light }),
      'a command the assistant carried out could not be written to the activity log',
    );
    warn.mockRestore();
  });

  it('switches off every light in the home in one reading, and names them as a group', async () => {
    const tv = randomUUID();
    const ceiling = randomUUID();
    await settings.setAiKey('typesafe', 'ts-test-key');
    const decisions = jev(() => ({
      ...offAnswers(),
      scope: sure('group', 0.95),
      place: sure('whole_home', 0.94),
      deviceType: sure('lights', 0.96),
      device: sure('none_of_these', 0.9),
    }));
    const { assistant, sent } = await assistantFor([{ kind: 'said', text: 'All off.' }], {
      devices: twoLights(tv, ceiling),
      decisions: decisions.transport,
    });

    const started = await assistant.start({ memberId, message: 'turn off all the lights' });
    await assistant.idle();

    expect(commanded).toEqual([
      { deviceId: tv, endpointId: 1, type: 'power' },
      { deviceId: ceiling, endpointId: 1, type: 'power' },
    ]);
    expect(sent[0]).toContain('- TV light: switched off.');
    expect(sent[0]).toContain('- Ceiling light: switched off.');
    const rows = await assistant.transcript(started.sessionId);
    const steps = (rows[1]?.data as { steps: ChatStepWire[] }).steps;
    expect(steps[0]?.text).toBe('Jev switched off 2 lights across the home');
  });

  it('does not wait on a light the hub knows is offline, and says which one', async () => {
    const tv = randomUUID();
    const ceiling = randomUUID();
    await settings.setAiKey('typesafe', 'ts-test-key');
    const decisions = jev(() => ({
      ...offAnswers(),
      scope: sure('group', 0.95),
      place: sure('whole_home', 0.94),
      deviceType: sure('lights', 0.96),
    }));
    const devices = twoLights(tv, ceiling).map((device) =>
      device.id === ceiling ? { ...device, online: false } : device,
    );
    const { assistant, sent } = await assistantFor([{ kind: 'said', text: 'One is off.' }], {
      devices,
      decisions: decisions.transport,
    });

    const started = await assistant.start({ memberId, message: 'turn off all the lights' });
    await assistant.idle();

    expect(attempted).toEqual([{ deviceId: tv, endpointId: 1, type: 'power' }]);
    expect(sent[0]).toContain('- TV light: switched off.');
    expect(sent[0]).toContain(
      '- Ceiling light: NOT done — it was to be switched off, but it is offline, so the hub did not try.',
    );
    const rows = await assistant.transcript(started.sessionId);
    const steps = (rows[1]?.data as { steps: ChatStepWire[] }).steps;
    expect(steps[0]?.text).toBe('Jev switched off TV light');
    expect(steps[0]?.detail).toContain('Ceiling light is offline and was not tried');
  });

  // ── Several requests in one sentence ──────────────────────────────────────

  /**
   * **The vendor's own smart-home demo, step for step.** Jev says the sentence
   * is several requests with a command among them; the conversation's own
   * model splits it; the parts go back to Jev in **one** request; what it is
   * sure of is carried out, and what is left — here a question — goes to the
   * model quoted, beside the account of what was done.
   */
  it('splits a sentence, carries out the command in it, and leaves the question to the model', async () => {
    const light = randomUUID();
    await settings.setAiKey('typesafe', 'ts-test-key');
    const decisions = jev((call) =>
      isParts(call)
        ? { ...offAnswers('d1', 'p0_'), p1_intent: sure('home_question', 0.96) }
        : { ...offAnswers('d1'), multiple: noul(0.9), anyCommand: noul(0.95) },
    );
    const splits: SplitInput[] = [];
    const { assistant, sent, efforts } = await assistantFor(
      [{ kind: 'said', text: 'Off, and it is 21 degrees.' }],
      {
        devices: oneLight(light),
        decisions: decisions.transport,
        split: async (input) => {
          splits.push(input);
          return {
            parts: ['turn off the ceiling light', 'what is the temperature?'],
            costUsd: 0.001,
            durationMs: 850,
          };
        },
      },
    );

    const message = 'turn off the ceiling light and what is the temperature?';
    const started = await assistant.start({ memberId, message });
    await assistant.idle();

    // Split on the home's own model and key, the one it chose and pays for.
    expect(splits).toHaveLength(1);
    expect(splits[0]).toMatchObject({
      provider: 'anthropic',
      modelId: 'claude-opus-5',
      secret: 'sk-ant-api03-test',
      said: message,
    });
    // Two requests in all: the sentence, then every part at once.
    expect(decisions.seen.calls).toHaveLength(2);
    expect(decisions.seen.calls[1]?.state).toEqual({
      parts: ['turn off the ceiling light', 'what is the temperature?'],
    });
    expect(commanded).toEqual([{ deviceId: light, endpointId: 1, type: 'power' }]);

    expect(sent[0]).toContain('- Ceiling light: switched off.');
    expect(sent[0]).toContain('which were NOT carried out');
    expect(sent[0]).toContain('- "what is the temperature?"');
    // The model still has something to work out, so the round is not eased.
    expect(efforts).toEqual([undefined]);

    const rows = await assistant.transcript(started.sessionId);
    const steps = (rows[1]?.data as { steps: ChatStepWire[] }).steps;
    expect(steps.map((step) => step.text)).toEqual([
      'Jev heard 2 requests',
      'Jev switched off Ceiling light',
      'Reading your home',
    ]);
    expect(steps[0]?.detail).toBe('“turn off the ceiling light” · “what is the temperature?” · split in 850 ms');

    // The split is paid for with the rest of the turn.
    const runs = await handle!.db.select().from(aiRunsTable);
    expect(runs[0]?.costUsd).toBeCloseTo(0.04 + 2 * DECISION_USD + 0.001, 9);
  });

  it('carries out two commands from one sentence and eases the round that says so', async () => {
    const tv = randomUUID();
    const ceiling = randomUUID();
    await settings.setAiKey('typesafe', 'ts-test-key');
    const decisions = jev((call) =>
      isParts(call)
        ? { ...offAnswers('d1', 'p0_'), ...offAnswers('d2', 'p1_') }
        : { ...offAnswers(), scope: sure('several_devices', 0.93) },
    );
    const { assistant, sent, efforts } = await assistantFor([{ kind: 'said', text: 'Both off.' }], {
      devices: twoLights(tv, ceiling),
      decisions: decisions.transport,
      split: async () => ({
        parts: ['turn off the TV light', 'turn off the ceiling light'],
        costUsd: 0.001,
        durationMs: 700,
      }),
    });

    await assistant.start({ memberId, message: 'turn off the TV light and the ceiling light' });
    await assistant.idle();

    expect(commanded).toEqual([
      { deviceId: tv, endpointId: 1, type: 'power' },
      { deviceId: ceiling, endpointId: 1, type: 'power' },
    ]);
    expect(sent[0]).toContain('Nothing else in their message needs doing.');
    expect(efforts).toEqual(['low']);
  });

  it('reads a sentence the model gives back whole as one request, and asks Jev nothing more', async () => {
    const light = randomUUID();
    await settings.setAiKey('typesafe', 'ts-test-key');
    const decisions = jev(() => ({ ...offAnswers('d1'), multiple: noul(0.8), anyCommand: noul(0.9) }));
    const message = 'turn off the ceiling light please and thank you';
    const { assistant, sent } = await assistantFor([{ kind: 'said', text: 'Done.' }], {
      devices: oneLight(light),
      decisions: decisions.transport,
      split: async () => ({ parts: [message], costUsd: 0.001, durationMs: 600 }),
    });

    const started = await assistant.start({ memberId, message });
    await assistant.idle();

    expect(decisions.seen.calls).toHaveLength(1);
    expect(commanded).toEqual([]);
    // The ordinary round, over the sentence as it was said.
    expect(sent).toEqual([message]);
    const rows = await assistant.transcript(started.sessionId);
    const steps = (rows[1]?.data as { steps: ChatStepWire[] }).steps;
    expect(steps[0]).toEqual({
      text: 'Jev was told it is one request after all',
      kind: 'deferred',
      detail: 'split in 600 ms',
    });
  });

  it('hands the whole sentence to the model when it cannot be split', async () => {
    const light = randomUUID();
    await settings.setAiKey('typesafe', 'ts-test-key');
    const decisions = jev(() => ({ ...offAnswers('d1'), multiple: noul(0.8), anyCommand: noul(0.9) }));
    const message = 'turn off the ceiling light and tell me a joke';
    const { assistant, sent } = await assistantFor([{ kind: 'said', text: 'Done.' }], {
      devices: oneLight(light),
      decisions: decisions.transport,
      split: async () => null,
    });

    const started = await assistant.start({ memberId, message });
    await assistant.idle();

    expect(commanded).toEqual([]);
    expect(sent).toEqual([message]);
    const rows = await assistant.transcript(started.sessionId);
    const steps = (rows[1]?.data as { steps: ChatStepWire[] }).steps;
    expect(steps[0]).toEqual({
      text: "Jev couldn't have the request split",
      kind: 'deferred',
      detail: 'the model did not split it',
    });
  });

  /**
   * **The seam never throws**, and this is the half of that the hub owns: a
   * throw out of the fast path used to be caught one level up as a turn that
   * could not be saved — a note, and no answer at all. Now it is the model's
   * sentence, whole, which is exactly the hub before any of this.
   */
  it('gives the model the sentence when anything in the fast path fails', async () => {
    const light = randomUUID();
    await settings.setAiKey('typesafe', 'ts-test-key');
    const decisions = jev(() => ({ ...offAnswers('d1'), multiple: noul(0.8), anyCommand: noul(0.9) }));
    const warn = vi.spyOn(log, 'warn');
    const message = 'turn off the ceiling light and the fan';
    const { assistant, sent } = await assistantFor([{ kind: 'said', text: 'Done.' }], {
      devices: oneLight(light),
      decisions: decisions.transport,
      split: async () => {
        throw new Error('the split fell over');
      },
    });

    const started = await assistant.start({ memberId, message });
    await assistant.idle();

    expect(sent).toEqual([message]);
    const rows = await assistant.transcript(started.sessionId);
    expect(rows.map((row) => [row.role, row.text])).toEqual([
      ['user', message],
      ['agent', 'Done.'],
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: started.sessionId }),
      'Jev: the fast path failed — the model has the sentence',
    );
    warn.mockRestore();
  });

  // ── Handing a job over without a round ────────────────────────────────────

  it('hands an automation request straight to the agent that writes rules', async () => {
    const light = randomUUID();
    await settings.setAiKey('typesafe', 'ts-test-key');
    const decisions = jev(() => ({
      intent: sure('automation_work', 0.97),
      route: sure('automations', 0.96),
      selfContained: noul(0.93),
      multiple: noul(0.1),
      anyCommand: noul(0.1),
    }));
    const { assistant, automationChat, sent } = await assistantFor([], {
      devices: oneLight(light),
      decisions: decisions.transport,
      delegated: [{ kind: 'said', text: 'Which days?' }],
    });

    const brief = 'turn the ceiling light off every night at eleven';
    const started = await assistant.start({ memberId, message: brief });
    await assistant.idle();
    await automationChat.idle();

    // No round of this agent's at all: the job went over in the person's words.
    expect(sent).toEqual([]);
    const rows = await assistant.transcript(started.sessionId);
    expect(rows.map((row) => row.role)).toEqual(['user', 'handoff']);
    const card = rows[1]?.data as { sessionId: string; brief: string };
    expect(card.brief).toBe(brief);
    expect((await automationChat.transcript(card.sessionId))[0]?.text).toBe(brief);
  });

  // ── Spoken ─────────────────────────────────────────────────────────────────

  it('works the device first out loud too, and the answer is still the model’s', async () => {
    const light = randomUUID();
    await settings.setAiKey('typesafe', 'ts-test-key');
    const decisions = jev(() => offAnswers('d1'));
    const { assistant, sent, efforts } = await assistantFor(
      [{ kind: 'said', text: 'The ceiling light is off.' }],
      { devices: oneLight(light), decisions: decisions.transport },
    );
    const sessionId = assistant.beginVoice();

    const answer = await assistant.askAloud({ sessionId, memberId, question: 'turn off the ceiling light' });

    expect(answer).toBe('The ceiling light is off.');
    expect(commanded).toEqual([{ deviceId: light, endpointId: 1, type: 'power' }]);
    expect(sent[0]).toContain('spoken aloud');
    expect(sent[0]).toContain('- Ceiling light: switched off.');
    // The digest above it was read a moment before the light went off.
    expect(sent[0]).toContain('may not show it yet');
    expect(efforts).toEqual(['low']);
    const logged = await handle!.db.select().from(activityTable);
    const command = logged.find((row) => row.kind === 'device.command');
    expect((command?.data as { via?: string } | null)?.via).toBe('voice');
  });

  // ── Speculating while somebody is still talking ────────────────────────────

  /**
   * **What a half-finished sentence worked out is used when it finishes** —
   * when it turns out to be the same sentence.
   *
   * A reading of a partial used to be paid for and thrown away, so the
   * finished sentence was read from scratch and the feature cost money to
   * change nothing. The voice asks for help a beat after somebody stops, so
   * the last partial read is usually the whole of what they said — and then
   * the turn spends no request at all.
   */
  it('reuses a reading of the very sentence that was finished', async () => {
    const light = randomUUID();
    await settings.setAiKey('typesafe', 'ts-test-key');
    const decisions = jev(() => offAnswers('d1'));
    const { assistant } = await assistantFor([{ kind: 'said', text: 'The ceiling light is off.' }], {
      devices: oneLight(light),
      decisions: decisions.transport,
    });
    const sessionId = assistant.beginVoice();

    await assistant.warmForSpeech({ sessionId, memberId, partial: 'Turn off the ceiling light' });
    expect(decisions.seen.calls).toHaveLength(1);
    // Nothing is done while the sentence is still being said.
    expect(commanded).toEqual([]);

    await assistant.askAloud({ sessionId, memberId, question: 'turn off the ceiling light.' });

    // Still the speculation's one request — punctuation and case aside, it was
    // the same sentence — and the light really went off on that reading.
    expect(decisions.seen.calls).toHaveLength(1);
    expect(commanded).toEqual([{ deviceId: light, endpointId: 1, type: 'power' }]);
    // And paid for once: when it was made, not again when it was used.
    const runs = await handle!.db.select().from(aiRunsTable);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.costUsd).toBeCloseTo(0.04 + DECISION_USD, 9);
  });

  /**
   * **And a sentence that carried on past the reading pays again.**
   *
   * The rule used to be `startsWith`, on the reasoning that carrying on
   * talking produces a superset — and a superset is exactly where the meaning
   * changes: "turn the bedroom light on" read while somebody was still saying
   * "— no, off" was acted on as *on*. Only the same sentence is reused now; a
   * longer one is read live, on the connection the speculation left open.
   */
  it('reads a sentence live when it carried on past the reading', async () => {
    const light = randomUUID();
    await settings.setAiKey('typesafe', 'ts-test-key');
    const decisions = jev(() => offAnswers('d1'));
    const { assistant } = await assistantFor([{ kind: 'said', text: 'Off.' }], {
      devices: oneLight(light),
      decisions: decisions.transport,
    });
    const sessionId = assistant.beginVoice();

    await assistant.warmForSpeech({ sessionId, memberId, partial: 'turn off the ceiling' });
    await assistant.askAloud({ sessionId, memberId, question: 'turn off the ceiling light' });

    expect(decisions.seen.calls).toHaveLength(2);
    expect(decisions.seen.calls[1]?.state).toEqual({ said: 'turn off the ceiling light' });
    expect(commanded).toEqual([{ deviceId: light, endpointId: 1, type: 'power' }]);
  });

  it('never answers the next sentence from a reading of the last one', async () => {
    const light = randomUUID();
    await settings.setAiKey('typesafe', 'ts-test-key');
    const decisions = jev(() => offAnswers('d1'));
    const { assistant } = await assistantFor(
      [
        { kind: 'said', text: 'Off.' },
        { kind: 'said', text: 'Off again.' },
      ],
      { devices: oneLight(light), decisions: decisions.transport },
    );
    const sessionId = assistant.beginVoice();

    await assistant.warmForSpeech({ sessionId, memberId, partial: 'turn off the ceiling light' });
    await assistant.askAloud({ sessionId, memberId, question: 'turn off the ceiling light' });
    await assistant.askAloud({ sessionId, memberId, question: 'turn off the ceiling light' });

    // The reading was consumed by the first; the second asked for its own.
    expect(decisions.seen.calls).toHaveLength(2);
  });

  // ── Getting the connection ready ──────────────────────────────────────────

  it('opens the connection when somebody opens the page, and only with a key', async () => {
    const decisions = jev(() => ({}));
    const { assistant } = await assistantFor([], { decisions: decisions.transport });
    assistant.prepare();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(decisions.seen.warmups).toBe(0);

    await settings.setAiKey('typesafe', 'ts-test-key');
    assistant.prepare();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(decisions.seen.warmups).toBe(1);
    // A warm-up is not a decision, and costs nothing.
    expect(decisions.seen.calls).toHaveLength(0);
  });

  // ── Saying why the fast path stood down ───────────────────────────────────

  /**
   * **A stand-down used to leave no trace**, so a light that took four seconds
   * rather than one looked the same whether Jev was off, slow, or 0.41 sure
   * between two lamps — and "why not Jev?" had no answer short of replaying
   * the sentence by hand. Now it is a line in the log every time, and a quiet
   * step in the round's working when it is one somebody could have expected
   * to go the other way.
   */
  it('says why Jev stood down, in the log and as a quiet step', async () => {
    const tv = randomUUID();
    const ceiling = randomUUID();
    await settings.setAiKey('typesafe', 'ts-test-key');
    const decisions = jev(() => ({
      ...offAnswers(),
      power: sure('on', 0.97),
      device: {
        type: 'choice',
        choice: 'd1',
        probabilities: { d1: 0.48, d2: 0.45 },
        confidence: 0.41,
      },
    }));
    const info = vi.spyOn(log, 'info');
    const { assistant, sent } = await assistantFor([{ kind: 'said', text: 'The TV light is on.' }], {
      devices: twoLights(tv, ceiling),
      decisions: decisions.transport,
    });

    const started = await assistant.start({ memberId, message: 'turn the light on' });
    await assistant.idle();

    // Nothing was carried out on a guess, and the model had the sentence whole.
    expect(commanded).toEqual([]);
    expect(sent).toEqual(['turn the light on']);
    const rows = await assistant.transcript(started.sessionId);
    const steps = (rows[1]?.data as { steps: ChatStepWire[] }).steps;
    // First in the round's working, because it happened first — and in the
    // same shape as every other step, so the stored trail draws it too.
    expect(steps[0]).toEqual({
      text: "Jev wasn't sure which device",
      kind: 'deferred',
      detail: expect.stringMatching(/^TV light or Ceiling light: 0\.41, needs 0\.85 · \d+ ms, new connection$/),
    });
    expect(steps[1]?.text).toBe('Reading your home');

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        jev: expect.objectContaining({
          question: 'device',
          reason: 'unsure',
          value: 0.41,
          min: 0.85,
          requestId: 'req-7',
        }),
        via: 'typed',
      }),
      expect.stringContaining("Jev stood down — wasn't sure which device"),
    );
    info.mockRestore();
  });

  it('logs a sentence it read as a question, and keeps it out of the trail', async () => {
    // Most of what anybody says to an assistant is not a device command, and
    // a step on every one of those turns would bury the one that matters.
    const light = randomUUID();
    await settings.setAiKey('typesafe', 'ts-test-key');
    const decisions = jev(() => ({ intent: sure('home_question', 0.97), route: sure('here', 0.99) }));
    const info = vi.spyOn(log, 'info');
    const { assistant } = await assistantFor([{ kind: 'said', text: 'It is on.' }], {
      devices: oneLight(light),
      decisions: decisions.transport,
    });

    const started = await assistant.start({ memberId, message: 'is the light on?' });
    await assistant.idle();

    const rows = await assistant.transcript(started.sessionId);
    const steps = (rows[1]?.data as { steps: ChatStepWire[] }).steps;
    expect(steps.map((step) => step.kind)).toEqual(['thinking']);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ jev: expect.objectContaining({ reason: 'declined' }) }),
      expect.stringContaining('Jev stood down — read it as a question about the home'),
    );
    info.mockRestore();
  });

  it('says nothing about Jev on a hub that has no key for it', async () => {
    const light = randomUUID();
    const info = vi.spyOn(log, 'info');
    const { assistant } = await assistantFor([{ kind: 'said', text: 'It is on.' }], {
      devices: oneLight(light),
    });

    const started = await assistant.start({ memberId, message: 'turn the light on' });
    await assistant.idle();

    const rows = await assistant.transcript(started.sessionId);
    const steps = (rows[1]?.data as { steps: ChatStepWire[] }).steps;
    expect(steps.map((step) => step.kind)).toEqual(['thinking']);
    expect(info).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Jev'));
    info.mockRestore();
  });

  it('refuses a handover the member’s role cannot make, in a sentence', async () => {
    const { assistant } = await assistantFor([]);
    // A guest holds no `automation.manage`, and the refusal is a sentence the
    // model can read out rather than a tool that was silently withheld — the
    // `RoleNotice` rule, one layer down.
    const [guest] = await handle!.db
      .select()
      .from(rolesTable)
      .where(eq(rolesTable.key, 'guest'));
    const guestId = randomUUID();
    await handle!.db
      .insert(membersTable)
      .values({ id: guestId, name: 'Kolya', role: 'member', roleId: guest!.id });
    await access.load();

    const tools = (
      assistant as unknown as {
        toolContext: (id: string) => {
          delegate: (agent: string, brief: string) => Promise<{ refused?: string }>;
        };
      }
    ).toolContext(guestId);
    const refused = await tools.delegate('automations', 'write me a rule');
    expect(refused.refused).toContain('automation.manage');

    // An agent this hub has never heard of is refused the same way rather than
    // throwing: the model reads it and says so.
    const unknown = await tools.delegate('laundry', 'do the washing');
    expect(unknown.refused).toContain('laundry');
  });
});
