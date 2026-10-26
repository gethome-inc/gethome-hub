import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { HubEventBus } from '../src/core/bus.js';
import { ActivityService } from '../src/core/activity.js';
import { PairingService } from '../src/core/pairing.js';
import { SettingsService } from '../src/core/settings.js';
import { DeviceRegistry } from '../src/core/registry.js';
import { PermitJoinService } from '../src/core/permit-join.js';
import { AiRunLog } from '../src/core/ai-runs.js';
import { MappingLibrary } from '../src/ai/library.js';
import {
  aiRunExchanges as aiRunExchangesTable,
  aiRuns as aiRunsTable,
  automationChatMessages as chatTable,
  members as membersTable,
} from '../src/db/schema.js';
import type { AutomationEngine, EngineRegistry } from '../src/automations/engine.js';
import type { AutomationChat } from '../src/ai/automation-chat.js';
import type { AssistantChat } from '../src/ai/assistant-chat.js';
import type { AssistantTurn } from '../src/ai/assistant-agent.js';
import type { AutomationConversation, AutomationTurn } from '../src/ai/automation-conversation.js';
import {
  CHAT_IMAGE_MAX_BYTES,
  CHAT_IMAGE_MAX_COUNT,
  type AgentConversation,
  type ChatImage,
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
 * What a chat message can carry besides its words: the model and effort it is
 * answered at, and photos — over the four routes that take a message, and in
 * the runtime underneath them.
 *
 * Three promises are what this suite is for. **The wire only grows**: every new
 * field is optional and an older app's message is stored exactly as it was.
 * **A photo is never written down**: the transcript row says what it was and
 * never what it looked like, and the provider history lets it go once its
 * round is over. And **the ledger stays right across a change of model**,
 * which is a conversation swapped out from under a cursor that measures the
 * old one.
 *
 * The seam stands in for the network, not for the rules — every refusal here
 * is the real check, the `createConversation` rule.
 */

const log = pino({ level: 'silent' });

/** A photo's worth of base64 that cannot occur by accident anywhere else. */
function photo(bytes = 2048): ChatImage & { type: 'image' } {
  return { type: 'image', mediaType: 'image/jpeg', data: randomBytes(bytes).toString('base64') };
}

/** What one stand-in conversation was opened on, sent and asked. */
interface Opened {
  provider: string;
  modelId: string;
  /** What each round was sent, priming included. */
  sent: string[];
  /** How many photos each round was handed, and at what effort. */
  rounds: { images: number; effort: string | undefined }[];
  /** What it has cost so far — bumped by a test to stand for spend no turn has
   *  banked yet. */
  spent: number;
}

/**
 * Stand-ins for both agents' conversations, recording what they were opened on
 * and what each round was handed. Each round costs a cent, so the ledger has
 * something real to sum.
 */
function standIns(
  answers: {
    /** A round's answer — or a promise of one, to hold a round open while a
     *  test sends the next message behind it. */
    assistant?: () => AssistantTurn | Promise<AssistantTurn>;
    automation?: () => AutomationTurn;
  } = {},
) {
  const opened: Opened[] = [];
  const record = (provider: string, modelId: string): Opened => {
    const entry: Opened = { provider, modelId, sent: [], rounds: [], spent: 0 };
    opened.push(entry);
    return entry;
  };
  const assistant = ({ provider, modelId }: { provider: string; modelId: string }) => {
    const entry = record(provider, modelId);
    const round = async (
      text: string,
      context?: { images?: readonly ChatImage[]; effort?: string; onStep?: (s: string, k: string) => void },
    ): Promise<AssistantTurn> => {
      entry.sent.push(text);
      entry.rounds.push({ images: context?.images?.length ?? 0, effort: context?.effort });
      entry.spent += 0.01;
      context?.onStep?.('Reading your home', 'thinking');
      return answers.assistant?.() ?? { kind: 'said', text: 'Done.' };
    };
    const conversation: AgentConversation<AssistantTurn> = {
      provider,
      modelId,
      effort: 'medium' as const,
      awaitingAnswer: () => false,
      costUsd: () => entry.spent,
      send: round,
      answer: round,
    };
    return conversation;
  };
  const automation = ({ provider, modelId }: { provider: string; modelId: string }) => {
    const entry = record(provider, modelId);
    const round = async (
      text: string,
      context?: { images?: readonly ChatImage[]; effort?: string; onStep?: (s: string, k: 'thinking') => void },
    ): Promise<AutomationTurn> => {
      entry.sent.push(text);
      entry.rounds.push({ images: context?.images?.length ?? 0, effort: context?.effort });
      entry.spent += 0.01;
      context?.onStep?.('Reading your home', 'thinking');
      return answers.automation?.() ?? { kind: 'said', text: 'On it.' };
    };
    const conversation: AutomationConversation = {
      provider,
      modelId,
      effort: 'medium' as const,
      awaitingAnswer: () => false,
      costUsd: () => entry.spent,
      send: round,
      answer: round,
    };
    return conversation;
  };
  return { opened, assistant, automation };
}

// ── Over a real server ─────────────────────────────────────────────────────────

describe('the four chat routes', () => {
  let handle: TestDb;
  let app: FastifyInstance;
  let engine: AutomationEngine;
  let automationChat: AutomationChat;
  let assistantChat: AssistantChat;
  let settings: SettingsService;
  let token: string;
  let ownerId: string;
  const fakes = standIns();

  const auth = () => ({ authorization: `Bearer ${token}` });
  /**
   * `object`, never `unknown`, for the payload — narrowing `unknown` leaves a
   * type `inject` resolves to its chainable overload, and every status code
   * after it stops being checked.
   */
  const post = (url: string, payload: object) =>
    app.inject({ method: 'POST', url, headers: auth(), payload });

  beforeAll(async () => {
    handle = (await openTestDb())!;
    const db = handle.db;
    const dir = mkdtempSync(path.join(tmpdir(), 'gethome-chat-options-'));
    const events = new HubEventBus();
    const access = await loadedAccess(db, events);
    const pairing = new PairingService(db, dir, log, access);
    await pairing.boot();
    const activity = new ActivityService(db, events);
    const registry = new DeviceRegistry(db, events, activity, log);
    settings = new SettingsService(db, Buffer.alloc(32).toString('base64'));
    await settings.setAiKey('anthropic', 'sk-ant-api03-test');
    const started = await startedAutomations(db, events, registry, activity, {
      settings,
      access,
      createConversation: fakes.automation,
      createAssistantConversation: fakes.assistant,
    });
    engine = started.engine;
    automationChat = started.chat;
    assistantChat = started.assistant;

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
      automationChat,
      assistantChat,
      history: await startedHistory(db, events),
      portraits: testPortraits(db, events),
      settings,
      home: await bootedHome(db, 'Chat Hub'),
      hubId: 'hub-chat-options-test',
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
    ownerId = (await db.query.members.findFirst())!.id;
  });

  afterAll(async () => {
    await engine?.stop();
    await app?.close();
    await handle?.close();
  });

  const idle = async () => {
    await assistantChat.idle();
    await automationChat.idle();
  };

  it('says on GET /hub what a message can carry, as presence', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/hub' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { chat?: unknown };
    // The block is what an app reads before offering any of the three; an
    // older hub strips them and answers 201, so absence must mean "don't".
    expect(body.chat).toEqual({
      models: true,
      efforts: ['low', 'medium', 'high'],
      images: {
        maxCount: CHAT_IMAGE_MAX_COUNT,
        maxBytes: CHAT_IMAGE_MAX_BYTES,
        mediaTypes: ['image/jpeg', 'image/png', 'image/webp'],
      },
    });
  });

  it('says which offered models read photos, beside each choice', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/settings/ai', headers: auth() });
    const body = response.json() as {
      assistant: { choices: Record<string, { id: string; images?: boolean }[]> };
    };
    const every = [...(body.assistant.choices['anthropic'] ?? []), ...(body.assistant.choices['openai'] ?? [])];
    expect(every.length).toBeGreaterThan(0);
    expect(every.every((choice) => choice.images === true)).toBe(true);
  });

  it('takes a model, an effort and photos on all four routes, and hands them to the turn', async () => {
    const before = fakes.opened.length;
    const extras = { model: 'claude-sonnet-5-5', effort: 'high', attachments: [photo()] };

    const assistantStart = await post('/api/v1/assistant/chat', { message: 'what is this?', ...extras });
    expect(assistantStart.statusCode).toBe(201);
    const assistantId = (assistantStart.json() as { sessionId: string }).sessionId;
    await idle();
    const assistantMore = await post(`/api/v1/assistant/chat/${assistantId}/messages`, {
      message: 'and this?',
      ...extras,
    });
    expect(assistantMore.statusCode).toBe(200);

    const automationStart = await post('/api/v1/automations/chat', { message: 'a rule for this', ...extras });
    expect(automationStart.statusCode).toBe(201);
    const automationId = (automationStart.json() as { sessionId: string }).sessionId;
    await idle();
    const automationMore = await post(`/api/v1/automations/chat/${automationId}/messages`, {
      message: 'and for this',
      ...extras,
    });
    expect(automationMore.statusCode).toBe(200);
    await idle();

    const opened = fakes.opened.slice(before);
    // Opened **on** the model asked for — not on the home's default and then
    // switched — and every round was handed its photo and its effort.
    expect(opened[0]?.modelId).toBe('claude-sonnet-5-5');
    const rounds = opened.flatMap((entry) => entry.rounds);
    expect(rounds).toHaveLength(4);
    expect(rounds.every((round) => round.images === 1 && round.effort === 'high')).toBe(true);
  });

  it('takes a message that is only a photo, and refuses one that is nothing at all', async () => {
    const pictureOnly = await post('/api/v1/assistant/chat', { message: '', attachments: [photo()] });
    expect(pictureOnly.statusCode).toBe(201);

    const empty = await post('/api/v1/assistant/chat', { message: '   ' });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ error: 'invalid_body' });

    const emptyWithNoList = await post('/api/v1/automations/chat', { message: '', attachments: [] });
    expect(emptyWithNoList.statusCode).toBe(400);
    await idle();
  });

  it('refuses too many photos, too large a photo, the wrong type and garbled base64', async () => {
    const tooMany = await post('/api/v1/assistant/chat', {
      message: 'these',
      attachments: Array.from({ length: CHAT_IMAGE_MAX_COUNT + 1 }, () => photo(16)),
    });
    expect(tooMany.statusCode).toBe(400);

    // One byte over the bound, decoded: base64 for exactly the ceiling plus a
    // single extra group.
    const oversized = randomBytes(CHAT_IMAGE_MAX_BYTES + 3).toString('base64');
    const tooLarge = await post('/api/v1/assistant/chat', {
      message: 'this',
      attachments: [{ type: 'image', mediaType: 'image/jpeg', data: oversized }],
    });
    expect(tooLarge.statusCode).toBe(400);
    expect((tooLarge.json() as { detail?: string }).detail).toMatch(/at most/);
    // The refusal says what was wrong and never hands the photo back.
    expect(tooLarge.body).not.toContain(oversized.slice(0, 64));

    const gif = await post('/api/v1/assistant/chat', {
      message: 'this',
      attachments: [{ type: 'image', mediaType: 'image/gif', data: photo(16).data }],
    });
    expect(gif.statusCode).toBe(400);

    const garbled = await post('/api/v1/assistant/chat', {
      message: 'this',
      attachments: [{ type: 'image', mediaType: 'image/png', data: 'not*base64' }],
    });
    expect(garbled.statusCode).toBe(400);

    const badEffort = await post('/api/v1/assistant/chat', { message: 'this', effort: 'max' });
    expect(badEffort.statusCode).toBe(400);
  });

  it('takes a body past the one-megabyte default, on the four routes alone', async () => {
    // A photo of a megabyte and a half is two megabytes of base64 — refused at
    // the door by the default every other route keeps.
    const big = photo(1_500_000);
    const response = await post('/api/v1/assistant/chat', { message: 'this', attachments: [big] });
    expect(response.statusCode).toBe(201);
    await idle();

    // And nothing else on the API grew the same mouth.
    const elsewhere = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/timezone',
      headers: auth(),
      payload: { timezone: 'UTC', padding: big.data },
    });
    expect(elsewhere.statusCode).toBe(413);
  });

  it('refuses a model this home cannot run, with a code and a sentence, before taking the message', async () => {
    const unknown = await post('/api/v1/assistant/chat', { message: 'hi', model: 'claude-nonsense-9' });
    expect(unknown.statusCode).toBe(409);
    expect(unknown.json()).toMatchObject({ error: 'model_unavailable' });
    expect((unknown.json() as { detail?: string }).detail).toBeTruthy();

    // Offered, but on a vendor this home holds no key for.
    const otherVendor = await post('/api/v1/automations/chat', { message: 'hi', model: 'gpt-6.1-sol' });
    expect(otherVendor.statusCode).toBe(409);
    expect(otherVendor.json()).toMatchObject({ error: 'model_unavailable' });
    expect((otherVendor.json() as { detail: string }).detail).toContain('OpenAI');

    const started = await post('/api/v1/assistant/chat', { message: 'hi' });
    const id = (started.json() as { sessionId: string }).sessionId;
    await idle();
    const rowsBefore = (await assistantChat.transcript(id)).length;
    const continued = await post(`/api/v1/assistant/chat/${id}/messages`, {
      message: 'again',
      model: 'gpt-6-luna',
    });
    expect(continued.statusCode).toBe(409);
    // Refused before the message was taken, so nothing was written for a turn
    // that would not run.
    expect((await assistantChat.transcript(id)).length).toBe(rowsBefore);
  });

  it('stores what a photo was on the person’s row, and its bytes nowhere at all', async () => {
    const sent = photo(4096);
    const started = await post('/api/v1/assistant/chat', {
      message: 'what is this?',
      model: 'claude-haiku-5-5',
      effort: 'low',
      attachments: [{ ...sent, ref: 'phone-copy-1', width: 1280, height: 960 }],
    });
    expect(started.statusCode).toBe(201);
    const ack = started.json() as { sessionId: string; messages: { data?: unknown }[] };
    // The acknowledgement is the row, and the row says what was asked.
    expect(ack.messages[0]?.data).toEqual({
      model: 'claude-haiku-5-5',
      effort: 'low',
      attachments: [
        { type: 'image', mediaType: 'image/jpeg', ref: 'phone-copy-1', width: 1280, height: 960, bytes: 4096 },
      ],
    });
    await idle();

    // Not in the transcript, not in the ledger, not in the exchange log —
    // anywhere this hub writes to disk.
    const needle = sent.data.slice(0, 64);
    const everything = JSON.stringify([
      await handle.db.select().from(chatTable),
      await handle.db.select().from(aiRunsTable),
      await handle.db.select().from(aiRunExchangesTable),
    ]);
    expect(everything).not.toContain(needle);
  });

  it('stores a plain message exactly as an older app’s always was', async () => {
    const started = await post('/api/v1/assistant/chat', { message: 'just words' });
    const ack = started.json() as { messages: { data?: unknown }[] };
    expect(ack.messages[0]).not.toHaveProperty('data');
    await idle();
  });

  it('says which conversations are the caller’s, and lists the others as not', async () => {
    const mine = (await post('/api/v1/assistant/chat', { message: 'mine' }).then((r) => r.json())) as {
      sessionId: string;
    };
    const otherId = randomUUID();
    await handle.db.insert(membersTable).values({ id: otherId, name: 'Anna', role: 'member' });
    const theirs = await assistantChat.start({ memberId: otherId, message: 'theirs' });
    await idle();

    const listed = (
      await app.inject({ method: 'GET', url: '/api/v1/assistant/chats', headers: auth() })
    ).json() as { sessionId: string; mine?: boolean }[];
    expect(listed.find((chat) => chat.sessionId === mine.sessionId)?.mine).toBe(true);
    expect(listed.find((chat) => chat.sessionId === theirs.sessionId)?.mine).toBe(false);
    expect(ownerId).toBeTruthy();
  });

  /**
   * **A refusal that stops nothing is not a refusal.** The second key on the
   * automations routes used to be checked by a helper that handed back the
   * Fastify reply, which is a thenable — so the `await` resolved it to
   * `undefined`, the 403 went out, and the handler carried on and started the
   * conversation anyway, on the home's money, for somebody it had just turned
   * away. The status code alone could never have caught that; the transcript
   * can.
   */
  it('refuses a writer without the AI key before anything is said, not after', async () => {
    const role = await post('/api/v1/roles', { name: 'Rules only', permissions: ['automation.manage'] });
    expect(role.statusCode).toBe(201);
    const invite = await post('/api/v1/invites', { roleId: (role.json() as { id: string }).id });
    const joined = await app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      payload: { code: (invite.json() as { code: string }).code, memberName: 'Rules' },
    });
    const writer = joined.json() as { token: string; member: { id: string } };
    const before = (await handle.db.select().from(chatTable)).length;

    const refused = await app.inject({
      method: 'POST',
      url: '/api/v1/automations/chat',
      headers: { authorization: `Bearer ${writer.token}` },
      payload: { message: 'write me a rule' },
    });
    // What this is guarding against happens *after* the response: a handler
    // that carried on past its own 403 runs on once `inject` has resolved. An
    // absence has no event to wait for, so it is given time to have happened —
    // and the turn it would have queued, time to have run.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await idle();

    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: 'forbidden', permission: 'hub.ai' });
    expect((await handle.db.select().from(chatTable)).length).toBe(before);
  });

  it('names the assistant conversation an automations chat was handed over from', async () => {
    const child = (
      (await post('/api/v1/automations/chat', { message: 'lights at dusk' })).json() as { sessionId: string }
    ).sessionId;
    const parent = randomUUID();
    await handle.db.insert(chatTable).values({
      sessionId: parent,
      role: 'handoff',
      text: 'lights at dusk',
      data: { agent: 'automations', title: 'Automations agent', brief: 'lights at dusk', sessionId: child },
      memberId: null,
      surface: 'assistant',
    });
    const own = (
      (await post('/api/v1/automations/chat', { message: 'one of my own' })).json() as { sessionId: string }
    ).sessionId;
    await idle();

    const transcript = (
      await app.inject({ method: 'GET', url: `/api/v1/automations/chat/${child}`, headers: auth() })
    ).json() as { handedFrom?: string };
    expect(transcript.handedFrom).toBe(parent);

    const listed = (
      await app.inject({ method: 'GET', url: '/api/v1/automations/chats', headers: auth() })
    ).json() as { sessionId: string; handedFrom?: string }[];
    expect(listed.find((chat) => chat.sessionId === child)?.handedFrom).toBe(parent);
    expect(listed.find((chat) => chat.sessionId === own)).not.toHaveProperty('handedFrom');

    const unhanded = (
      await app.inject({ method: 'GET', url: `/api/v1/automations/chat/${own}`, headers: auth() })
    ).json() as object;
    expect(unhanded).not.toHaveProperty('handedFrom');
  });
});

// ── The runtime underneath ─────────────────────────────────────────────────────

describe('a turn’s model, effort and photos, in the runtime', () => {
  let handle: TestDb | null = null;
  let events: HubEventBus;
  let settings: SettingsService;
  let memberId: string;
  const engines: AutomationEngine[] = [];

  afterAll(async () => {
    await Promise.allSettled(engines.map((engine) => engine.stop()));
    await handle?.close();
  });

  beforeEach(async () => {
    handle ??= (await openTestDb())!;
    await resetDb(handle.db);
    events = new HubEventBus();
    settings = new SettingsService(handle.db, Buffer.alloc(32).toString('base64'));
    await settings.setAiKey('anthropic', 'sk-ant-api03-test');
    memberId = randomUUID();
    await handle.db.insert(membersTable).values({ id: memberId, name: 'Anna', role: 'owner' });
  });

  async function runtimes(answers?: Parameters<typeof standIns>[0]) {
    const fakes = standIns(answers);
    const registry: EngineRegistry = {
      listDevices: () => [],
      execute: async () => undefined,
    } as unknown as EngineRegistry;
    const activity = new ActivityService(handle!.db, events);
    const started = await startedAutomations(handle!.db, events, registry, activity, {
      settings,
      createConversation: fakes.automation,
      createAssistantConversation: fakes.assistant,
    });
    engines.push(started.engine);
    /** The live session behind an id — the runtime's own map, read for what
     *  only it can show: which conversation object is answering now. */
    const live = (id: string) =>
      (
        started.assistant as unknown as {
          sessions: Map<string, { conversation: unknown; priming?: string }>;
        }
      ).sessions.get(id);
    return { ...started, fakes, live };
  }

  /** Every `ai_runs` row for a session, oldest first. */
  async function ledger(sessionId: string) {
    const rows = await handle!.db.select().from(aiRunsTable);
    return rows.filter((row) => row.sessionId === sessionId);
  }

  it('hands a photo to one round, then lets it go — a fresh conversation, primed with the record', async () => {
    const { assistant, fakes, live } = await runtimes();
    const started = await assistant.start({
      memberId,
      message: 'what is this?',
      turn: { images: [photo()] },
    });
    await assistant.idle();

    // The round saw the photo …
    expect(fakes.opened[0]?.rounds[0]?.images).toBe(1);
    // … and the conversation that saw it is gone: a second one is answering,
    // on the same model, and it has never been handed a photo.
    expect(fakes.opened).toHaveLength(2);
    expect(fakes.opened[1]?.modelId).toBe(fakes.opened[0]?.modelId);
    const priming = live(started.sessionId)?.priming ?? '';
    expect(priming).toContain('They said: what is this? (with 1 photo, no longer available)');

    // The next message reaches the new conversation with that record in front
    // of it, and no photo.
    await assistant.reply(started.sessionId, memberId, 'and the colour?');
    await assistant.idle();
    expect(fakes.opened[1]?.sent[0]).toContain('no longer available');
    expect(fakes.opened[1]?.sent[0]).toMatch(/and the colour\?$/);
    expect(fakes.opened[1]?.rounds[0]?.images).toBe(0);
    // A text-only turn does not rebase.
    expect(fakes.opened).toHaveLength(2);
  });

  /**
   * A message sent while a round runs is written at once, so its row lands
   * ahead of the answer that round goes on to write — and it is still waiting
   * its own turn. The record a rebase primes with is what the model has been
   * through: the answer in, the waiting message out (it is about to be sent,
   * and recapping it too would hand the model the same message twice).
   */
  it('rebases on what has been said, not on a message still waiting its turn', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let rounds = 0;
    const { assistant, fakes } = await runtimes({
      assistant: async () => {
        rounds += 1;
        if (rounds === 1) await held;
        return { kind: 'said', text: rounds === 1 ? 'A table lamp.' : 'Warm white.' };
      },
    });
    const started = await assistant.start({ memberId, message: 'what is this?', turn: { images: [photo()] } });
    await assistant.reply(started.sessionId, memberId, 'and its colour?');
    release();
    await assistant.idle();

    const next = fakes.opened[1]?.sent[0] ?? '';
    expect(next).toContain('They said: what is this? (with 1 photo, no longer available)');
    // The answer written after the waiting message was taken is history …
    expect(next).toContain('You said: A table lamp.');
    // … and the waiting message is the message, once.
    expect(next).not.toContain('They said: and its colour?');
    expect(next).toMatch(/and its colour\?$/);
  });

  it('switches model on what has been said, including an answer written after the message was taken', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let rounds = 0;
    const { assistant, fakes } = await runtimes({
      assistant: async () => {
        rounds += 1;
        if (rounds === 1) await held;
        return { kind: 'said', text: rounds === 1 ? 'The hall is at 21°.' : 'Sonnet here.' };
      },
    });
    const started = await assistant.start({ memberId, message: 'how warm is the hall?' });
    await assistant.reply(started.sessionId, memberId, 'and the kitchen?', { model: 'claude-sonnet-5-5' });
    await assistant.reply(started.sessionId, memberId, 'and outside?');
    release();
    await assistant.idle();

    const moved = fakes.opened[1];
    expect(moved?.modelId).toBe('claude-sonnet-5-5');
    const primed = moved?.sent[0] ?? '';
    expect(primed).toContain('They said: how warm is the hall?');
    expect(primed).toContain('You said: The hall is at 21°.');
    expect(primed).not.toContain('They said: and the kitchen?');
    // A message queued behind the switch is not history yet either.
    expect(primed).not.toContain('and outside?');
    expect(primed).toMatch(/and the kitchen\?$/);
    // And it runs on the new conversation, as an ordinary next message.
    expect(moved?.sent[1]).toBe('and outside?');
  });

  it('writes no empty run for a rebased conversation that never ran again', async () => {
    const { assistant } = await runtimes();
    const started = await assistant.start({ memberId, message: 'this?', turn: { images: [photo()] } });
    await assistant.idle();
    await assistant.close(started.sessionId);

    const rows = await ledger(started.sessionId);
    // The round that saw the photo, and nothing for the conversation that
    // replaced it and was closed before it was asked anything.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.costUsd).toBeCloseTo(0.01, 6);
  });

  it('keeps the ledger whole across the rebase', async () => {
    const { assistant } = await runtimes();
    const started = await assistant.start({ memberId, message: 'this?', turn: { images: [photo()] } });
    await assistant.idle();
    await assistant.reply(started.sessionId, memberId, 'and now?');
    await assistant.idle();

    const rows = await ledger(started.sessionId);
    const total = rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
    // Two rounds, a cent each, on two conversations — neither lost, neither
    // counted twice.
    expect(total).toBeCloseTo(0.02, 6);
  });

  it('moves a conversation onto another model when a message asks, with the old spend written first', async () => {
    const { assistant, fakes } = await runtimes();
    const started = await assistant.start({ memberId, message: 'first' });
    await assistant.idle();
    expect(fakes.opened[0]?.modelId).toBe('claude-opus-5-5');
    // Spend the turn's own bank did not see — the shape of a round still
    // running up cost when the next message arrives.
    fakes.opened[0]!.spent += 0.05;

    await assistant.reply(started.sessionId, memberId, 'second', { model: 'claude-sonnet-5-5' });
    await assistant.idle();

    const moved = fakes.opened[1];
    expect(moved?.modelId).toBe('claude-sonnet-5-5');
    // Primed with what came *before* this message, which is then the message.
    expect(moved?.sent[0]).toContain('They said: first');
    expect(moved?.sent[0]).not.toContain('They said: second');
    expect(moved?.sent[0]).toMatch(/second$/);

    const rows = await ledger(started.sessionId);
    const on = (model: string) =>
      rows.filter((row) => row.modelId === model).reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
    expect(on('claude-opus-5-5')).toBeCloseTo(0.06, 6);
    expect(on('claude-sonnet-5-5')).toBeCloseTo(0.01, 6);
  });

  it('does not switch for a message that names the model already answering', async () => {
    const { assistant, fakes } = await runtimes();
    const started = await assistant.start({
      memberId,
      message: 'first',
      turn: { model: 'claude-sonnet-5-5' },
    });
    await assistant.idle();
    await assistant.reply(started.sessionId, memberId, 'second', { model: 'claude-sonnet-5-5' });
    await assistant.idle();
    expect(fakes.opened).toHaveLength(1);
    expect(fakes.opened[0]?.sent).toHaveLength(2);
  });

  it('revives a conversation on the model its person last chose', async () => {
    const { assistant, fakes } = await runtimes();
    const started = await assistant.start({
      memberId,
      message: 'first',
      turn: { model: 'claude-haiku-5-5' },
    });
    await assistant.idle();
    await assistant.close(started.sessionId);

    // No model on this message: it carries the conversation on, as the live
    // one would have been.
    await assistant.reply(started.sessionId, memberId, 'again');
    await assistant.idle();
    expect(fakes.opened.at(-1)?.modelId).toBe('claude-haiku-5-5');
  });

  it('revives on the home’s own model when the chosen one can no longer run', async () => {
    await settings.setAiKey('openai', 'sk-proj-test');
    const { assistant, fakes } = await runtimes();
    const started = await assistant.start({
      memberId,
      message: 'first',
      turn: { model: 'gpt-6-luna' },
    });
    await assistant.idle();
    expect(fakes.opened[0]?.modelId).toBe('gpt-6-luna');
    await assistant.close(started.sessionId);
    await settings.clearAiProvider('openai');

    await assistant.reply(started.sessionId, memberId, 'again');
    await assistant.idle();
    expect(fakes.opened.at(-1)?.modelId).toBe('claude-opus-5-5');
  });

  it('runs a typed round at the effort it asked for, and writes that down', async () => {
    const { assistant, fakes } = await runtimes();
    const started = await assistant.start({ memberId, message: 'think hard', turn: { effort: 'high' } });
    await assistant.idle();
    expect(fakes.opened[0]?.rounds[0]?.effort).toBe('high');
    const rows = await ledger(started.sessionId);
    expect(rows.map((row) => row.effort)).toContain('high');
  });

  it('calls a conversation that opened with a picture what it is', async () => {
    const { assistant } = await runtimes();
    const one = await assistant.start({ memberId, message: '', turn: { images: [photo()] } });
    const two = await assistant.start({ memberId, message: '  ', turn: { images: [photo(), photo()] } });
    await assistant.idle();

    const listed = await assistant.list(memberId);
    expect(listed.find((chat) => chat.sessionId === one.sessionId)?.title).toBe('Photo');
    expect(listed.find((chat) => chat.sessionId === two.sessionId)?.title).toBe('2 photos');
  });

  it('recaps a wordless photo as one', async () => {
    const { assistant, live } = await runtimes();
    const started = await assistant.start({ memberId, message: '', turn: { images: [photo()] } });
    await assistant.idle();
    expect(live(started.sessionId)?.priming).toContain('They sent 1 photo (no longer available).');
  });

  it('puts how long the round took on the first row it wrote, and only that one', async () => {
    const rule = {
      version: 1,
      name: 'Evening lights',
      mode: 'single',
      triggers: [{ kind: 'manual' }],
      actions: [{ kind: 'logActivity', message: 'Evening' }],
    };
    const { chat } = await runtimes({
      automation: () => ({
        kind: 'submitted',
        rules: [{ document: rule, replaces: null }],
        text: 'Saved it, switched off.',
      }),
    });
    const started = await chat.start({ memberId, message: 'evening lights' });
    await chat.idle();

    const rows = await chat.transcript(started.sessionId);
    expect(rows.map((row) => row.role)).toEqual(['user', 'agent', 'preview']);
    const took = (row: (typeof rows)[number] | undefined) =>
      (row?.data as { tookMs?: unknown } | undefined)?.tookMs;
    expect(took(rows[0])).toBeUndefined();
    expect(Number.isInteger(took(rows[1]))).toBe(true);
    expect(took(rows[1]) as number).toBeGreaterThanOrEqual(0);
    expect(took(rows[2])).toBeUndefined();
  });

  it('answers whose each conversation is, when asked who is asking', async () => {
    const { assistant } = await runtimes();
    const otherId = randomUUID();
    await handle!.db.insert(membersTable).values({ id: otherId, name: 'Ben', role: 'member' });
    const mine = await assistant.start({ memberId, message: 'mine' });
    const theirs = await assistant.start({ memberId: otherId, message: 'theirs' });
    await assistant.idle();

    const listed = await assistant.list(memberId);
    expect(listed.find((chat) => chat.sessionId === mine.sessionId)?.mine).toBe(true);
    expect(listed.find((chat) => chat.sessionId === theirs.sessionId)?.mine).toBe(false);
    // Nobody asking, nothing claimed.
    expect((await assistant.list())[0]).not.toHaveProperty('mine');
  });

  it('reads the newest handover back as where a conversation came from', async () => {
    const { chat } = await runtimes();
    const child = (await chat.start({ memberId, message: 'lights at dusk' })).sessionId;
    await chat.idle();
    const first = randomUUID();
    const second = randomUUID();
    for (const [parent, at] of [
      [first, new Date(Date.now() - 60_000)],
      [second, new Date()],
    ] as const) {
      await handle!.db.insert(chatTable).values({
        sessionId: parent,
        at,
        role: 'handoff',
        text: 'lights at dusk',
        data: { agent: 'automations', sessionId: child },
        surface: 'assistant',
      });
    }
    expect(await chat.handedFrom(child)).toBe(second);
    expect(await chat.handedFrom(randomUUID())).toBeUndefined();
  });
});
