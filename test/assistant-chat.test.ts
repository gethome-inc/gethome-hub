import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { HubEventBus } from '../src/core/bus.js';
import { ActivityService } from '../src/core/activity.js';
import { AiRunLog } from '../src/core/ai-runs.js';
import { AccessService } from '../src/core/access.js';
import { SettingsService } from '../src/core/settings.js';
import {
  activity as activityTable,
  aiRuns as aiRunsTable,
  members as membersTable,
  roles as rolesTable,
} from '../src/db/schema.js';
import { asc, eq } from 'drizzle-orm';
import { openTestDb, resetDb, startedAutomations, type TestDb } from './helpers/db.js';
import { AssistantChat } from '../src/ai/assistant-chat.js';
import { AutomationNotConfiguredError } from '../src/ai/automation-chat.js';
import type { AssistantTurn } from '../src/ai/assistant-agent.js';
import type { AgentConversation, ChatTurnContext } from '../src/ai/chat/chat-runtime.js';
import { refusalSentence } from '../src/ai/chat/agent-loop.js';
import type { AutomationConversation, AutomationTurn } from '../src/ai/automation-conversation.js';
import type { EngineRegistry } from '../src/automations/engine.js';
import { AGENT_MODELS, effectiveAgentModel } from '../src/ai/models.js';

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
    // A real row: `automation_chat_messages.member_id` is a foreign key, and a
    // made-up id makes every transcript write fail silently into its own catch.
    memberId = randomUUID();
    await handle.db.insert(membersTable).values({ id: memberId, name: 'Anna', role: 'owner' });

    assistantFor = async (turns, options) => {
      const registry = {
        listDevices: () => options?.devices ?? [],
        execute: async (deviceId: string, endpointId: number, command: { type: string }) => {
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
        modelId: 'claude-opus-5-5',
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
        modelId: 'claude-opus-5-5',
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
    await settings.clearAiProvider('anthropic');
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
    // *provider* survives it, off the model table: the vendor was a real
    // choice and the retired id was not. And it runs what replaced it.
    expect(effectiveAgentModel('claude-opus-4-6', both)).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-5-5',
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
    expect(effectiveAgentModel('claude-opus-5-5', onlyOpenAi)).toEqual({
      provider: 'openai',
      modelId: AGENT_MODELS.openai.default,
    });
    // And a deliberate OpenAI choice is kept, rather than being read as a
    // fallback and moved to that provider's default.
    expect(effectiveAgentModel('gpt-6-luna', onlyOpenAi)).toEqual({
      provider: 'openai',
      modelId: 'gpt-6-luna',
    });
    // A retired one of that vendor's moves to what replaced it, on that vendor.
    expect(effectiveAgentModel('gpt-5.6-terra', onlyOpenAi)).toEqual({
      provider: 'openai',
      modelId: 'gpt-6-sol',
    });
    // Neither key is the only case with no answer — the caller refuses on it.
    expect(effectiveAgentModel('claude-opus-5-5', { anthropic: false, openai: false })).toBeNull();

    // End to end: the same home, through the settings route both agents read.
    await settings.setAiKey('openai', 'sk-proj-test');
    await settings.clearAiProvider('anthropic');
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
    await settings.setAutomationsModel('claude-opus-5-5');
    let ai = await settings.getAiSettings();
    expect([ai.assistant.model, ai.automations.model]).toEqual([
      'claude-sonnet-5',
      'claude-opus-5-5',
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
    await settings.setAiModel('claude-opus-5-5', 'anthropic');
    await settings.setAssistantModel(null);
    ai = await settings.getAiSettings();
    expect(ai.anthropic.model).toBe('claude-opus-5-5');
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

  it('does not report a command as failed because the activity log could not take its row', async () => {
    // The lamp has gone off by the time the row is written. A write that
    // fails there is bookkeeping, and it once told the model — and so the
    // person — that a light which had just gone off had not. Here the device
    // is one the registry knows and the store does not (removed a moment
    // ago), so the row's foreign key refuses it.
    const light = randomUUID();
    const warn = vi.spyOn(log, 'warn');
    const { assistant } = await assistantFor([{ kind: 'said', text: 'Done.' }], {
      devices: [
        {
          id: light,
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
    const started = await assistant.start({ memberId, message: 'lights off' });
    await assistant.idle();

    const tools = (
      assistant as unknown as {
        toolContext: (
          id: string,
          sessionId: string,
        ) => { control: (deviceId: string, endpointId: number, command: object) => Promise<void> };
      }
    ).toolContext(memberId, started.sessionId);
    await expect(tools.control(light, 1, { type: 'power', on: false })).resolves.toBeUndefined();

    expect(commanded).toEqual([{ deviceId: light, endpointId: 1, type: 'power' }]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: light }),
      'a command the assistant carried out could not be written to the activity log',
    );
    const rows = await handle!.db.select().from(activityTable);
    expect(rows.find((row) => row.kind === 'device.command')).toBeUndefined();
    warn.mockRestore();
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
