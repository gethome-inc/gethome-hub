import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { HubEventBus, type AutomationChatEvent } from '../src/core/bus.js';
import { ActivityService } from '../src/core/activity.js';
import { PairingService } from '../src/core/pairing.js';
import { SettingsService } from '../src/core/settings.js';
import { DeviceRegistry } from '../src/core/registry.js';
import { PermitJoinService } from '../src/core/permit-join.js';
import { AiRunLog } from '../src/core/ai-runs.js';
import { MappingLibrary } from '../src/ai/library.js';
import { AiUnavailableError } from '../src/ai/errors.js';
import { declinedRows, failureNote, failureSentence, switchOffer } from '../src/ai/chat/failure.js';
import type { AutomationEngine } from '../src/automations/engine.js';
import type { AssistantTurn } from '../src/ai/assistant-agent.js';
import type { AutomationConversation, AutomationTurn } from '../src/ai/automation-conversation.js';
import {
  retryTarget,
  stillAskable,
  type AgentConversation,
  type ChatMessageWire,
  type ChatTurnContext,
} from '../src/ai/chat/chat-runtime.js';
import {
  bootedHome,
  loadedAccess,
  loadedFavorites,
  openTestDb,
  resetDb,
  startedAutomations,
  startedHistory,
  testBroker,
  testPortraits,
  type TestDb,
} from './helpers/db.js';

/**
 * A round that could not be answered, and asking it again — on the other
 * vendor's model, usually, since the commonest failures are an account's.
 *
 * What is pinned is what the person sees and what they do not have to do: the
 * note says which model failed and why in words they can act on, and offers
 * the other vendor's model when the home has its key; pressing it answers the
 * message they already sent rather than making them send it again, and the
 * conversation carries on on that model — after a restart too. And what must
 * never happen does not: the same message run twice, an old failure answered
 * in the middle of a newer exchange, somebody else's conversation asked again,
 * or a device worked twice because the model asked again was never told the
 * first one had already worked it.
 */

const log = pino({ level: 'silent' });

/** What failed, by model id — a stand-in throws it, or declines. */
const failures = new Map<string, unknown>();
const refusals = new Set<string>();
/**
 * Steps a stand-in reports before it fails, by model id — the fourth value is
 * whether the step's change took (`ChatStepWire.done`).
 */
const before = new Map<string, [string, string, string, boolean?][]>();
/** Models a conversation cannot be opened on, for a switch that fails. */
const unopenable = new Set<string>();
/** Hand-overs a stand-in reports, as Anthropic's server-side fallback would. */
const handOvers = new Map<string, [string, string, boolean][]>();
/** A stand-in that waits on this before answering, for the double-press. */
let gate: Promise<void> | null = null;
/**
 * One wait per round, in the order rounds begin — for holding the second of
 * two queued rounds while the first one fails.
 */
const holds: Promise<void>[] = [];

/** Everything a stand-in was asked, and with what. */
const asked: { model: string; text: string; images: number }[] = [];

function standIn<Turn>(provider: string, modelId: string) {
  const round = async (text: string, context?: ChatTurnContext): Promise<Turn> => {
    asked.push({ model: modelId, text, images: context?.images?.length ?? 0 });
    for (const [summary, kind, detail, done] of before.get(modelId) ?? []) {
      context?.onStep?.(summary, kind, detail, done);
    }
    for (const [from, to, earlier] of handOvers.get(modelId) ?? []) context?.onHandOver?.(from, to, earlier);
    if (gate !== null) await gate;
    const hold = holds.shift();
    if (hold !== undefined) await hold;
    const failure = failures.get(modelId);
    if (failure !== undefined) throw failure;
    if (refusals.has(modelId)) {
      return { kind: 'stopped', reason: 'The model declined to answer that.', refused: true } as Turn;
    }
    return { kind: 'said', text: `${modelId} answered.` } as Turn;
  };
  return {
    provider,
    modelId,
    effort: 'medium' as const,
    awaitingAnswer: () => false,
    costUsd: () => 0,
    send: round,
    answer: round,
  };
}

/** Wait for something a turn running off the request will do. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('a round that could not be answered', () => {
  let handle: TestDb;
  let app: FastifyInstance;
  let engine: AutomationEngine;
  let settings: SettingsService;
  let idle: () => Promise<void>;
  let assistantChat: Awaited<ReturnType<typeof startedAutomations>>['assistant'];
  let token: string;
  let otherToken: string;
  const frames: AutomationChatEvent[] = [];

  const auth = (bearer: string) => ({ authorization: `Bearer ${bearer}` });
  const post = (url: string, payload?: object, bearer = token) =>
    app.inject({ method: 'POST', url, headers: auth(bearer), ...(payload !== undefined ? { payload } : {}) });
  type Row = { id: string; role: string; text: string; data?: Record<string, unknown> };
  const read = async (surface: string, sessionId: string): Promise<Row[]> => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/${surface}/chat/${sessionId}`,
      headers: auth(token),
    });
    return (response.json() as { messages: Row[] }).messages;
  };
  /** A conversation whose first message failed on GPT-6.1 Sol. */
  const failedOnOpenAi = async (surface: string, payload: object = {}): Promise<string> => {
    failures.set('gpt-6.1-sol', new AiUnavailableError('billing', '402 {"error":{"message":"You exceeded your current quota."}}'));
    const started = await post(`/api/v1/${surface}/chat`, {
      message: 'switch the hall light on',
      model: 'gpt-6.1-sol',
      ...payload,
    });
    expect(started.statusCode).toBe(201);
    await idle();
    return (started.json() as { sessionId: string }).sessionId;
  };

  beforeAll(async () => {
    handle = (await openTestDb())!;
    await resetDb(handle.db);
    const db = handle.db;
    const dir = mkdtempSync(path.join(tmpdir(), 'gethome-chat-retry-'));
    const events = new HubEventBus();
    events.on('assistantChat', (event) => frames.push(event));
    events.on('automationChat', (event) => frames.push(event));
    const access = await loadedAccess(db, events);
    const pairing = new PairingService(db, dir, log, access);
    await pairing.boot();
    const activity = new ActivityService(db, events);
    const registry = new DeviceRegistry(db, events, activity, log);
    settings = new SettingsService(db, Buffer.alloc(32).toString('base64'));
    await settings.setAiKey('anthropic', 'sk-ant-api03-test');
    await settings.setAiKey('openai', 'sk-proj-test');
    const started = await startedAutomations(db, events, registry, activity, {
      settings,
      access,
      createConversation: ({ provider, modelId }) => {
        if (unopenable.has(modelId)) throw new Error(`${modelId} would not open`);
        return standIn<AutomationTurn>(provider, modelId) as AutomationConversation;
      },
      createAssistantConversation: ({ provider, modelId }) => {
        if (unopenable.has(modelId)) throw new Error(`${modelId} would not open`);
        return standIn<AssistantTurn>(provider, modelId) as AgentConversation<AssistantTurn>;
      },
    });
    engine = started.engine;
    assistantChat = started.assistant;
    idle = async () => {
      await started.assistant.idle();
      await started.chat.idle();
    };

    app = await buildServer({
      db,
      log,
      events,
      registry,
      favorites: await loadedFavorites(db, events),
      access,
      pairing,
      activity,
      automations: engine,
      automationStore: started.store,
      automationChat: started.chat,
      assistantChat: started.assistant,
      history: await startedHistory(db, events),
      portraits: testPortraits(db, events),
      settings,
      home: await bootedHome(db, 'Retry Hub'),
      hubId: 'hub-chat-retry-test',
      version: '0.1.0-test',
      dataDir: dir,
      radioBudget: 'one',
      z2mDataDir: path.join(dir, 'zigbee2mqtt'),
      zigbeeEnvFile: path.join(dir, 'zigbee.env'),
      mqtt: testBroker(),
      permitJoin: new PermitJoinService(undefined, log, () => {}),
      aiRuns: new AiRunLog(db, events),
      mappings: new MappingLibrary({ db, settings, registry, log }),
    });

    const code = readFileSync(path.join(dir, 'pairing-code'), 'utf8').trim();
    const claimed = await app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      payload: { code, memberName: 'Georgy', deviceName: 'iPhone' },
    });
    token = (claimed.json() as { token: string }).token;
    const invite = await post('/api/v1/invites', {});
    const joined = await app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      payload: { code: (invite.json() as { code: string }).code, memberName: 'Kolya' },
    });
    otherToken = (joined.json() as { token: string }).token;
  });

  beforeEach(async () => {
    failures.clear();
    refusals.clear();
    before.clear();
    unopenable.clear();
    handOvers.clear();
    gate = null;
    holds.length = 0;
    asked.length = 0;
    frames.length = 0;
    await settings.setAiKey('anthropic', 'sk-ant-api03-test');
  });

  afterAll(async () => {
    await engine?.stop();
    await app?.close();
    await handle?.close();
  });

  for (const surface of ['assistant', 'automations'] as const) {
    it(`says on the ${surface}’s note which model failed and why, and offers the other vendor’s`, async () => {
      const sessionId = await failedOnOpenAi(surface);
      const rows = await read(surface, sessionId);
      expect(rows.map((row) => row.role)).toEqual(['user', 'note']);
      // A sentence somebody can act on — never the provider's status and JSON.
      expect(rows[1]!.text).toBe('GPT-6.1 Sol couldn’t answer: this home’s OpenAI account is out of credit.');
      expect(rows[1]!.data).toMatchObject({
        failure: { provider: 'openai', model: 'gpt-6.1-sol', kind: 'billing' },
        switchTo: { model: 'claude-opus-5-5', label: 'Opus 5.5', provider: 'anthropic' },
      });
      // Credit is not something asking the same model again would fix.
      expect((rows[1]!.data!['failure'] as { transient?: boolean }).transient).toBeUndefined();
    });

    it(`answers the ${surface}’s message again on the model offered, without a second message`, async () => {
      const sessionId = await failedOnOpenAi(surface);
      const retried = await post(`/api/v1/${surface}/chat/${sessionId}/retry`, { model: 'claude-opus-5-5' });
      expect(retried.statusCode).toBe(202);
      expect(retried.json()).toEqual({ sessionId, retrying: true });
      await idle();

      const rows = await read(surface, sessionId);
      expect(rows.map((row) => [row.role, row.text])).toEqual([
        ['user', 'switch the hall light on'],
        ['note', 'GPT-6.1 Sol couldn’t answer: this home’s OpenAI account is out of credit.'],
        ['agent', 'claude-opus-5-5 answered.'],
      ]);
      // The note says where the conversation went, and a phone showing it
      // was told it changed.
      expect(rows[1]!.data).toMatchObject({ retried: { model: 'claude-opus-5-5' } });
      expect(frames).toContainEqual(expect.objectContaining({ sessionId, phase: 'amend', text: 'retry' }));

      // The model asked again was told it was being asked again, and was
      // asked the message itself.
      const last = asked.at(-1)!;
      expect(last.model).toBe('claude-opus-5-5');
      expect(last.text).toContain('the model it went to could not answer it');
      expect(last.text.endsWith('switch the hall light on')).toBe(true);
      // Told in words of its own, never by reading the note back as history.
      expect(last.text).not.toContain('(the hub noted:');
    });
  }

  it('carries on on the model it was answered on, after the hub has forgotten the conversation', async () => {
    const sessionId = await failedOnOpenAi('assistant');
    await post(`/api/v1/assistant/chat/${sessionId}/retry`, { model: 'claude-opus-5-5' });
    await idle();
    // Forgotten, as a restart or the idle sweep forgets it.
    await app.inject({ method: 'DELETE', url: `/api/v1/assistant/chat/${sessionId}`, headers: auth(token) });

    const next = await post(`/api/v1/assistant/chat/${sessionId}/messages`, { message: 'and the kitchen?' });
    expect(next.statusCode).toBe(200);
    await idle();
    expect(asked.at(-1)?.model).toBe('claude-opus-5-5');
  });

  it('never runs the same message twice', async () => {
    const sessionId = await failedOnOpenAi('assistant');
    let open: () => void = () => undefined;
    gate = new Promise((resolve) => {
      open = resolve;
    });
    const first = await post(`/api/v1/assistant/chat/${sessionId}/retry`, { model: 'claude-opus-5-5' });
    expect(first.statusCode).toBe(202);
    // Pressed again — or from another phone — while the first is answering.
    const second = await post(`/api/v1/assistant/chat/${sessionId}/retry`, { model: 'claude-opus-5-5' });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: 'nothing_to_retry' });
    gate = null;
    open();
    await idle();

    // And once it has been answered, the failure is history.
    const third = await post(`/api/v1/assistant/chat/${sessionId}/retry`, { model: 'claude-opus-5-5' });
    expect(third.statusCode).toBe(409);
    expect(third.json()).toMatchObject({ error: 'nothing_to_retry' });
    expect(asked.filter((entry) => entry.model === 'claude-opus-5-5')).toHaveLength(1);
  });

  it('never answers an old failure in the middle of a newer exchange', async () => {
    const sessionId = await failedOnOpenAi('assistant');
    failures.clear();
    await post(`/api/v1/assistant/chat/${sessionId}/messages`, { message: 'never mind, what time is it?' });
    await idle();
    const response = await post(`/api/v1/assistant/chat/${sessionId}/retry`, { model: 'claude-opus-5-5' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'nothing_to_retry' });
  });

  it('is only ever asked by the person whose conversation it is', async () => {
    const sessionId = await failedOnOpenAi('assistant');
    const theirs = await post(`/api/v1/assistant/chat/${sessionId}/retry`, { model: 'claude-opus-5-5' }, otherToken);
    expect(theirs.statusCode).toBe(409);
    expect(theirs.json()).toMatchObject({ error: 'not_your_conversation' });

    const gone = await post(`/api/v1/assistant/chat/${randomUUID()}/retry`, { model: 'claude-opus-5-5' });
    expect(gone.statusCode).toBe(410);
    expect(gone.json()).toMatchObject({ error: 'conversation_ended' });
  });

  it('refuses a model this home cannot run before taking anything', async () => {
    const sessionId = await failedOnOpenAi('assistant');
    const unknown = await post(`/api/v1/assistant/chat/${sessionId}/retry`, { model: 'gpt-9' });
    expect(unknown.statusCode).toBe(409);
    expect(unknown.json()).toMatchObject({ error: 'model_unavailable' });
    const nameless = await post(`/api/v1/assistant/chat/${sessionId}/retry`, {});
    expect(nameless.statusCode).toBe(400);
    // Still there to be asked properly.
    const rows = await read('assistant', sessionId);
    expect(rows.at(-1)?.data).not.toHaveProperty('retried');
  });

  it('offers the other vendor when the model declined, too', async () => {
    refusals.add('gpt-6.1-sol');
    const started = await post('/api/v1/assistant/chat', { message: 'is my front door secure?', model: 'gpt-6.1-sol' });
    await idle();
    const { sessionId } = started.json() as { sessionId: string };
    const rows = await read('assistant', sessionId);
    expect(rows[1]).toMatchObject({
      role: 'note',
      text: 'The model declined to answer that.',
      data: {
        failure: { provider: 'openai', model: 'gpt-6.1-sol', kind: 'refused' },
        switchTo: { model: 'claude-opus-5-5' },
      },
    });

    // Asked again, the message goes after all — so the model is not also told
    // that it was left out.
    await post(`/api/v1/assistant/chat/${sessionId}/retry`, { model: 'claude-opus-5-5' });
    await idle();
    const told = asked.at(-1)!;
    expect(told.model).toBe('claude-opus-5-5');
    expect(told.text).not.toContain('left out of this record');
    expect(told.text).toContain('the model it went to could not answer it');
    expect(told.text.endsWith('is my front door secure?')).toBe(true);
  });

  it('leaves a declined message out of the model’s memory, and on the page', async () => {
    refusals.add('gpt-6.1-sol');
    before.set('gpt-6.1-sol', [['Working a device', 'writing', 'Porch light → on', true]]);
    const started = await post('/api/v1/assistant/chat', {
      message: 'porch light on, then tell me how to get past my alarm',
      model: 'gpt-6.1-sol',
    });
    await idle();
    const { sessionId } = started.json() as { sessionId: string };
    refusals.clear();
    before.clear();

    await post(`/api/v1/assistant/chat/${sessionId}/messages`, { message: 'just the porch light, then' });
    await idle();
    const next = asked.at(-1)!;
    // A conversation rebuilt without it: the next message is not read beside
    // what was declined, so it is not declined for it — and the model is told
    // there was one, and what had already been done.
    expect(next.text).not.toContain('get past my alarm');
    expect(next.text).toContain('(They sent a message here that was declined, so it is left out of this record.)');
    expect(next.text).toContain(
      'Before declining their message, the model had already done this, and it stays done:\n- Working a device: Porch light → on',
    );
    expect(next.text.endsWith('just the porch light, then')).toBe(true);

    // The person still sees what they asked and what came back.
    const rows = await read('assistant', sessionId);
    expect(rows.map((row) => [row.role, row.text])).toEqual([
      ['user', 'porch light on, then tell me how to get past my alarm'],
      ['note', 'The model declined to answer that.'],
      ['user', 'just the porch light, then'],
      ['agent', 'gpt-6.1-sol answered.'],
    ]);
  });

  it('offers nothing it cannot run, and asking the same model again is still allowed', async () => {
    await settings.clearAiProvider('anthropic');
    failures.set('gpt-6.1-sol', new AiUnavailableError('overloaded', '529 overloaded'));
    const started = await post('/api/v1/assistant/chat', { message: 'hello', model: 'gpt-6.1-sol' });
    await idle();
    const { sessionId } = started.json() as { sessionId: string };
    const rows = await read('assistant', sessionId);
    expect(rows[1]!.text).toBe('GPT-6.1 Sol couldn’t answer: OpenAI is overloaded right now.');
    expect(rows[1]!.data).toMatchObject({ failure: { kind: 'overloaded', transient: true } });
    expect(rows[1]!.data).not.toHaveProperty('switchTo');

    failures.clear();
    const again = await post(`/api/v1/assistant/chat/${sessionId}/retry`, { model: 'gpt-6.1-sol' });
    expect(again.statusCode).toBe(202);
    await idle();
    expect((await read('assistant', sessionId)).at(-1)).toMatchObject({ role: 'agent', text: 'gpt-6.1-sol answered.' });
    // Even on the same model, on a conversation opened for it — told why —
    // rather than on the history the failed round left behind.
    expect(asked.at(-1)).toMatchObject({ model: 'gpt-6.1-sol' });
    expect(asked.at(-1)!.text).toContain('the model it went to could not answer it');
  });

  it('tells the model asked again what the failed round had already done', async () => {
    before.set('gpt-6.1-sol', [
      ['Looking at your home', 'reading', 'Hall light'],
      ['Working a device', 'writing', 'Hall light → on', true],
      // Tried, and it did not take — never told as done.
      ['Working a device', 'writing', 'Vacuum didn’t answer'],
      ['Could not hand that over', 'writing', 'That agent is not available.'],
    ]);
    failures.set('gpt-6.1-sol', new AiUnavailableError('network', 'fetch failed'));
    const started = await post('/api/v1/assistant/chat', {
      message: 'hall light on and start the vacuum',
      model: 'gpt-6.1-sol',
    });
    await idle();
    const { sessionId } = started.json() as { sessionId: string };
    await post(`/api/v1/assistant/chat/${sessionId}/retry`, { model: 'claude-opus-5-5' });
    await idle();

    const told = asked.at(-1)!.text;
    expect(told).toContain('Before that model failed, it had already done this:\n- Working a device: Hall light → on');
    expect(told).toContain('Check what is already done before doing any of it again.');
    // Reading is not doing, so it is not in the list — and neither is a
    // change that did not take.
    expect(told).not.toContain('Looking at your home');
    expect(told).not.toContain('Vacuum');
    expect(told).not.toContain('Could not hand that over');
  });

  it('says in the round’s working when another Claude answered, once a turn', async () => {
    // Two rounds of one turn answered by the model that took over: the
    // working says so once, as a step an app keeps with the answer.
    handOvers.set('claude-opus-5-5', [
      ['Opus 5.5', 'Opus 4.8', false],
      ['Opus 5.5', 'Opus 4.8', true],
    ]);
    const started = await post('/api/v1/assistant/chat', { message: 'is the front door locked?' });
    await idle();
    const { sessionId } = started.json() as { sessionId: string };
    const answer = (await read('assistant', sessionId)).at(-1)!;
    expect(answer).toMatchObject({ role: 'agent', text: 'claude-opus-5-5 answered.' });
    const steps = (answer.data?.['steps'] ?? []) as { text: string; kind: string; detail?: string }[];
    expect(steps.filter((step) => step.kind === 'handover')).toEqual([
      {
        text: 'Answered by Opus 4.8',
        kind: 'handover',
        detail: 'Opus 5.5 declined this, so Anthropic passed it to Opus 4.8.',
      },
    ]);
    expect(frames.filter((frame) => frame.sessionId === sessionId && frame.kind === 'handover')).toHaveLength(1);
  });

  it('sends the photos the app sends again, and says so when it sends none', async () => {
    const photo = { type: 'image', mediaType: 'image/jpeg', data: Buffer.from('jpeg').toString('base64'), ref: 'p1' };
    const sessionId = await failedOnOpenAi('assistant', { message: '', attachments: [photo] });

    // Without them: the hub kept none, so the model is told what is missing.
    await post(`/api/v1/assistant/chat/${sessionId}/retry`, { model: 'claude-opus-5-5' });
    await idle();
    expect(asked.at(-1)).toMatchObject({ model: 'claude-opus-5-5', images: 0 });
    expect(asked.at(-1)!.text.endsWith('(They sent 1 photo, no longer available.)')).toBe(true);

    // With them: the photo goes, and no caption is sent as words.
    const second = await failedOnOpenAi('assistant', { message: '', attachments: [photo] });
    await post(`/api/v1/assistant/chat/${second}/retry`, { model: 'claude-opus-5-5', attachments: [photo] });
    await idle();
    expect(asked.at(-1)).toMatchObject({ model: 'claude-opus-5-5', images: 1 });
    expect(asked.at(-1)!.text.endsWith('Photo')).toBe(false);
  });

  /**
   * A message sent while a round runs is written at once, so it lands *ahead*
   * of that round's failure note: `[FIRST, SECOND, note]`. "The newest
   * message before the note" was then SECOND — still queued behind — which was
   * answered twice while FIRST never was. The note names its message now, and
   * one with another message of the person's after it has been moved on from.
   */
  it('asks again the message a failure names, and nothing once another is queued behind it', async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    holds.push(
      new Promise<void>((resolve) => (releaseFirst = resolve)),
      new Promise<void>((resolve) => (releaseSecond = resolve)),
    );
    failures.set('gpt-6.1-sol', new AiUnavailableError('overloaded', '529 overloaded'));
    const started = await post('/api/v1/assistant/chat', { message: 'FIRST', model: 'gpt-6.1-sol' });
    const { sessionId } = started.json() as { sessionId: string };
    await until(() => asked.length === 1, 'the first round');
    await post(`/api/v1/assistant/chat/${sessionId}/messages`, { message: 'SECOND' });

    releaseFirst();
    await until(() => asked.length === 2, 'the second round, queued behind the first');
    const rows = await read('assistant', sessionId);
    expect(rows.map((row) => [row.role, row.text.slice(0, 6)])).toEqual([
      ['user', 'FIRST'],
      ['user', 'SECOND'],
      ['note', 'GPT-6.'],
    ]);
    expect(rows[2]!.data).toMatchObject({ failure: { messageId: rows[0]!.id } });
    const moved = await post(`/api/v1/assistant/chat/${sessionId}/retry`, { model: 'claude-opus-5-5' });
    expect(moved.statusCode).toBe(409);
    expect((moved.json() as { error: string }).error).toBe('nothing_to_retry');

    // SECOND fails as well, and is the one its own note asks again.
    releaseSecond();
    await idle();
    failures.clear();
    const asking = await post(`/api/v1/assistant/chat/${sessionId}/retry`, { model: 'claude-opus-5-5' });
    expect(asking.statusCode).toBe(202);
    await idle();
    expect(asked.map((entry) => [entry.model, entry.text.split('\n').at(-1)])).toEqual([
      ['gpt-6.1-sol', 'FIRST'],
      ['gpt-6.1-sol', 'SECOND'],
      ['claude-opus-5-5', 'SECOND'],
    ]);
  });

  /**
   * A declined message was left out of the rebase straight after it and read
   * again by every record after that — a switch of model, a photo let go, a
   * conversation woken after a restart — so the classifier that declined it
   * met it again and declined what followed.
   */
  it('leaves a declined message out of every record the conversation is rebuilt from', async () => {
    refusals.add('claude-opus-5-5');
    const started = await post('/api/v1/assistant/chat', { message: 'DECLINED REQUEST' });
    await idle();
    const { sessionId } = started.json() as { sessionId: string };
    refusals.clear();
    const placeholder = '(They sent a message here that was declined, so it is left out of this record.)';

    // A switch of model.
    await post(`/api/v1/assistant/chat/${sessionId}/messages`, { message: 'on sonnet', model: 'claude-sonnet-5-5' });
    await idle();
    expect(asked.at(-1)!.model).toBe('claude-sonnet-5-5');
    expect(asked.at(-1)!.text).not.toContain('DECLINED REQUEST');
    expect(asked.at(-1)!.text).toContain(placeholder);

    // A photo let go after its round, and the message after it.
    const photo = { type: 'image', mediaType: 'image/jpeg', data: Buffer.from('jpeg').toString('base64'), ref: 'p2' };
    await post(`/api/v1/assistant/chat/${sessionId}/messages`, { message: 'what is this', attachments: [photo] });
    await idle();
    await post(`/api/v1/assistant/chat/${sessionId}/messages`, { message: 'after the photo' });
    await idle();
    expect(asked.at(-1)!.text).not.toContain('DECLINED REQUEST');
    expect(asked.at(-1)!.text).toContain(placeholder);

    // A conversation woken from its transcript.
    await app.inject({ method: 'DELETE', url: `/api/v1/assistant/chat/${sessionId}`, headers: auth(token) });
    await post(`/api/v1/assistant/chat/${sessionId}/messages`, { message: 'after a restart' });
    await idle();
    expect(asked.at(-1)!.text).not.toContain('DECLINED REQUEST');
    expect(asked.at(-1)!.text).toContain(placeholder);

    // Still on the page, every time.
    expect((await read('assistant', sessionId))[0]).toMatchObject({ role: 'user', text: 'DECLINED REQUEST' });
  });

  /**
   * The note was marked asked-again before the turn ran, so a model that could
   * not be started — or a conversation dropped behind the turn's back — left a
   * note claiming a retry that never happened, and a revival reopened the
   * conversation on that model.
   */
  /**
   * The recheck runs before the turn's own `try`, so a transcript that could
   * not be read there rejected the conversation's `inFlight` — which the
   * route, having answered 202, never listens to, and which takes a hub down.
   */
  it('lets a retry go when its conversation cannot be read back, and the note still offers it', async () => {
    const sessionId = await failedOnOpenAi('assistant');
    const original = assistantChat.transcript.bind(assistantChat);
    let reads = 0;
    // The first read is the route's own check; the second is the recheck when
    // the retry's turn comes round.
    const spy = vi.spyOn(assistantChat, 'transcript').mockImplementation(async (id: string) => {
      reads += 1;
      if (reads === 2) throw new Error('SQLITE_BUSY: database is locked');
      return original(id);
    });
    try {
      const accepted = await post(`/api/v1/assistant/chat/${sessionId}/retry`, { model: 'claude-opus-5-5' });
      expect(accepted.statusCode).toBe(202);
      await idle();
    } finally {
      spy.mockRestore();
    }
    expect(asked.some((entry) => entry.model === 'claude-opus-5-5')).toBe(false);
    expect(frames.some((frame) => frame.sessionId === sessionId && frame.phase === 'turn')).toBe(true);
    const rows = await read('assistant', sessionId);
    expect(rows.at(-1)!.data).not.toHaveProperty('retried');

    const again = await post(`/api/v1/assistant/chat/${sessionId}/retry`, { model: 'claude-opus-5-5' });
    expect(again.statusCode).toBe(202);
    await idle();
    expect(asked.at(-1)!.model).toBe('claude-opus-5-5');
  });

  it('marks a failure asked again only once the turn has really begun', async () => {
    const sessionId = await failedOnOpenAi('assistant');
    unopenable.add('claude-opus-5-5');
    const accepted = await post(`/api/v1/assistant/chat/${sessionId}/retry`, { model: 'claude-opus-5-5' });
    expect(accepted.statusCode).toBe(202);
    await idle();
    const rows = await read('assistant', sessionId);
    // The first note never claims it was asked again; the failure to start is
    // a note of its own, naming the same message and askable in its turn.
    expect(rows[1]!.data).not.toHaveProperty('retried');
    expect(rows.at(-1)).toMatchObject({
      role: 'note',
      data: { failure: { model: 'claude-opus-5-5', kind: 'unavailable', messageId: rows[0]!.id } },
    });
    expect(frames.some((frame) => frame.sessionId === sessionId && frame.phase === 'amend')).toBe(false);
  });
});

describe('the words on a failure', () => {
  const usable = { anthropic: true, openai: true };

  it('names the model and the vendor’s account, for every kind the classifier knows', () => {
    const said = (kind: ConstructorParameters<typeof AiUnavailableError>[0]) =>
      failureSentence('anthropic', 'claude-opus-5-5', new AiUnavailableError(kind, 'raw')).text;
    expect(said('billing')).toBe('Opus 5.5 couldn’t answer: this home’s Anthropic account is out of credit.');
    expect(said('usage_limit')).toBe('Opus 5.5 couldn’t answer: this home’s Anthropic account has reached its usage limit.');
    expect(said('rate_limited')).toBe(
      'Opus 5.5 couldn’t answer: Anthropic is limiting how fast this home’s key can be used. Try again in a minute.',
    );
    expect(said('auth_failed')).toBe('Opus 5.5 couldn’t answer: Anthropic didn’t accept this home’s key.');
    expect(said('overloaded')).toBe('Opus 5.5 couldn’t answer: Anthropic is overloaded right now.');
    expect(said('network')).toBe('Opus 5.5 couldn’t answer: your hub couldn’t reach Anthropic.');
    expect(said('aborted')).toBe('Opus 5.5 took too long to answer, so your hub stopped waiting.');
  });

  it('gives anything else in the provider’s own words, without the envelope', () => {
    const error = new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Bad thing"}}');
    expect(failureSentence('openai', 'gpt-6.1-sol', error)).toEqual({
      kind: 'failed',
      text: 'GPT-6.1 Sol couldn’t answer: Bad thing.',
    });
  });

  it('offers the other vendor’s default, and only when it can run', () => {
    expect(switchOffer('openai', usable)).toEqual({ model: 'claude-opus-5-5', label: 'Opus 5.5', provider: 'anthropic' });
    expect(switchOffer('anthropic', usable)).toEqual({ model: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', provider: 'openai' });
    expect(switchOffer('anthropic', { anthropic: true, openai: false })).toBeUndefined();
    expect(switchOffer('someone-else', usable)).toBeUndefined();
  });

  it('says asking again may work only where it may', () => {
    for (const kind of ['rate_limited', 'overloaded', 'network', 'aborted'] as const) {
      expect(failureNote('openai', 'gpt-6.1-sol', kind, 'x', usable).data.failure.transient).toBe(true);
    }
    for (const kind of ['billing', 'usage_limit', 'auth_failed', 'refused', 'unavailable', 'failed'] as const) {
      expect(failureNote('openai', 'gpt-6.1-sol', kind, 'x', usable).data.failure).not.toHaveProperty('transient');
    }
    // Settings that could not be read are no offer, never a second failure.
    expect(failureNote('openai', 'gpt-6.1-sol', 'billing', 'x', undefined).data).not.toHaveProperty('switchTo');
  });
});

describe('which failure is asked again', () => {
  const row = (id: string, role: ChatMessageWire['role'], data?: unknown): ChatMessageWire => ({
    id,
    at: '2026-10-27T00:00:00.000Z',
    role,
    text: id,
    ...(data !== undefined ? { data } : {}),
  });
  const failed = (id: string, messageId?: string) =>
    row(id, 'note', { failure: { provider: 'openai', model: 'gpt-6.1-sol', kind: 'overloaded', ...(messageId ? { messageId } : {}) } });

  it('answers the message the note names, and only while nothing of the person’s follows it', () => {
    expect(retryTarget([row('m1', 'user'), failed('n1', 'm1')])?.message.id).toBe('m1');
    expect(retryTarget([row('m1', 'user'), row('m2', 'user'), failed('n1', 'm1')])).toBeNull();
    // A note between them is not the person moving on.
    expect(
      retryTarget([row('m1', 'user'), row('m2', 'user'), failed('n1', 'm1'), failed('n2', 'm2')])?.message.id,
    ).toBe('m2');
    // A note naming something that is not a message of theirs asks nothing.
    expect(retryTarget([row('a1', 'agent'), failed('n1', 'a1')])).toBeNull();
    // Only the newest row.
    expect(retryTarget([row('m1', 'user'), failed('n1', 'm1'), row('a1', 'agent')])).toBeNull();
  });

  it('reads a note from before notes named their message only where that is unambiguous', () => {
    expect(retryTarget([row('a0', 'agent'), row('m1', 'user'), failed('n1')])?.message.id).toBe('m1');
    expect(retryTarget([row('m1', 'user'), row('m2', 'user'), failed('n1')])).toBeNull();
  });

  it('lets a retry run only while nothing but the person’s messages followed its note', () => {
    const rows = [row('m1', 'user'), failed('n1', 'm1')];
    expect(stillAskable(rows, 'n1')?.id).toBe('n1');
    // A message queued behind the retry is answered after it.
    expect(stillAskable([...rows, row('m2', 'user')], 'n1')?.id).toBe('n1');
    // Anything answered in the meantime is the conversation moving on.
    expect(stillAskable([...rows, row('m2', 'user'), row('a2', 'agent')], 'n1')).toBeNull();
    expect(stillAskable(rows, 'gone')).toBeNull();
  });

  it('leaves out a declined message and its refusal, until somebody has asked it again', () => {
    const refused = (id: string, messageId: string, retried?: boolean) =>
      row(id, 'note', {
        failure: { provider: 'anthropic', model: 'claude-opus-5-5', kind: 'refused', messageId },
        ...(retried ? { retried: { model: 'gpt-6.1-sol' } } : {}),
      });
    expect([...declinedRows([row('m1', 'user'), refused('n1', 'm1')])].sort()).toEqual(['m1', 'n1']);
    expect([...declinedRows([row('m1', 'user'), refused('n1', 'm1', true)])]).toEqual([]);
    // Any other failure is history the record reads.
    expect([...declinedRows([row('m1', 'user'), failed('n1', 'm1')])]).toEqual([]);
  });
});
