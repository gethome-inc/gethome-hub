import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { HubEventBus, type AutomationChatEvent, type ChatRoundSoFar } from '../src/core/bus.js';
import { ActivityService } from '../src/core/activity.js';
import { PairingService } from '../src/core/pairing.js';
import { SettingsService } from '../src/core/settings.js';
import { DeviceRegistry } from '../src/core/registry.js';
import { PermitJoinService } from '../src/core/permit-join.js';
import { AiRunLog } from '../src/core/ai-runs.js';
import { MappingLibrary } from '../src/ai/library.js';
import { members as membersTable } from '../src/db/schema.js';
import type { AutomationEngine, EngineRegistry } from '../src/automations/engine.js';
import type { AssistantTurn } from '../src/ai/assistant-agent.js';
import type { AutomationConversation, AutomationTurn } from '../src/ai/automation-conversation.js';
import type { AgentConversation, ChatTurnContext } from '../src/ai/chat/chat-runtime.js';
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
 * A round as far as it has got, for a socket that joins it part-way
 * (`chatRound`, `ChatRuntime.roundsSoFar`) — and `answering`, which has to be
 * exact for a phone deciding whether the round it was drawing is over.
 *
 * What is pinned is that the snapshot is the round **as its frames left it**:
 * the steps a client would hold (reasoning hung on the step it was produced
 * under, narration as a `said` step), the words it paused on while it is back
 * at work, the reply from its first word once it is writing one — and that a
 * socket subscribing in the middle hears it before anything else of the round,
 * so the frames carry on from exactly there.
 */

const log = pino({ level: 'silent' });

/** Wait for something a turn running off the request is about to do. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A point a script waits at until the test lets it on — and says it is there. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const state = { reached: false };
  return {
    state,
    open,
    pass: async () => {
      state.reached = true;
      await opened;
    },
  };
}

type Script = (text: string, context: ChatTurnContext | undefined) => Promise<AssistantTurn>;

/**
 * A round that does what a real one does, in order: the wait, its reasoning, a
 * look at the home, a sentence of narration, a device switched — and then its
 * reply, held part-way.
 */
function lampRound(atWork: ReturnType<typeof gate>, midReply: ReturnType<typeof gate>): Script {
  return async (_text, context) => {
    context?.onStep?.('Thinking', 'thinking');
    context?.onThinking?.('They want the desk lamp ');
    context?.onThinking?.('on.');
    context?.onStep?.('Looking at the lamps', 'reading');
    context?.onDelta?.("I'll switch ");
    context?.onDelta?.('it on.');
    context?.onSaid?.("I'll switch it on.");
    context?.onStep?.('Switching the desk lamp on', 'acting', 'Desk lamp', true);
    await atWork.pass();
    context?.onDelta?.('Done — the desk');
    await midReply.pass();
    context?.onDelta?.(' lamp is on.');
    return { kind: 'said', text: 'Done — the desk lamp is on.' };
  };
}

/** The four steps that round has taken by its first gate, as a client holds them. */
const LAMP_STEPS = [
  { text: 'Thinking', kind: 'thinking', detail: 'They want the desk lamp on.' },
  { text: 'Looking at the lamps', kind: 'reading' },
  { text: "I'll switch it on.", kind: 'said' },
  // `done` is the stored copy's alone, as on the frame.
  { text: 'Switching the desk lamp on', kind: 'acting', detail: 'Desk lamp' },
];

/** A stand-in conversation running whatever script the test has put in place. */
function standIn(play: { script?: Script }) {
  const round = async (text: string, context?: ChatTurnContext): Promise<AssistantTurn> =>
    play.script !== undefined ? play.script(text, context) : { kind: 'said', text: 'Done.' };
  return {
    provider: 'anthropic',
    modelId: 'claude-opus-5-5',
    effort: 'medium' as const,
    awaitingAnswer: () => false,
    costUsd: () => 0,
    send: round,
    answer: round,
  };
}

// ── The runtime ──────────────────────────────────────────────────────────────

describe('a round so far, in the runtime', () => {
  let handle: TestDb | null = null;
  let events: HubEventBus;
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
    memberId = randomUUID();
    await handle.db.insert(membersTable).values({ id: memberId, name: 'Anna', role: 'owner' });
  });

  async function assistantWith(play: { script?: Script }) {
    const settings = new SettingsService(handle!.db, Buffer.alloc(32).toString('base64'));
    await settings.setAiKey('anthropic', 'sk-ant-api03-test');
    const registry = { listDevices: () => [], execute: async () => undefined } as unknown as EngineRegistry;
    const started = await startedAutomations(handle!.db, events, registry, new ActivityService(handle!.db, events), {
      settings,
      createAssistantConversation: () => standIn(play) as AgentConversation<AssistantTurn>,
      createConversation: () => standIn({}) as unknown as AutomationConversation,
    });
    engines.push(started.engine);
    return started.assistant;
  }

  it('is the round as its frames left it: at work over the words it paused on, then writing its reply', async () => {
    const atWork = gate();
    const midReply = gate();
    const play: { script?: Script } = { script: lampRound(atWork, midReply) };
    const assistant = await assistantWith(play);

    const started = await assistant.start({ memberId, message: 'desk lamp on please' });
    const asked = started.messages[0]!.id;
    await until(() => atWork.state.reached, 'the round to be at work');

    const working = assistant.roundsSoFar(memberId);
    expect(working).toHaveLength(1);
    const [round] = working as [ChatRoundSoFar];
    expect(round).toMatchObject({ surface: 'assistant', sessionId: started.sessionId, answering: asked });
    expect(round.steps).toEqual(LAMP_STEPS);
    // Back at work: the narration is a step, and still what stands where the
    // reply goes — nothing is being written, so nothing is timed yet.
    expect(round.held).toBe("I'll switch it on.");
    expect(round.reply).toBeUndefined();
    expect(round.workedMs).toBeUndefined();
    expect(round.thinking).toBeUndefined();
    // A conversation's first round has nothing before it to be told apart from.
    expect(round.since).toBeUndefined();
    expect(round.elapsedMs).toBeGreaterThanOrEqual(0);

    // Somebody else's socket is told about nothing of it.
    expect(assistant.roundsSoFar(randomUUID())).toEqual([]);

    atWork.open();
    await until(() => midReply.state.reached, 'the reply to begin');
    const [writing] = assistant.roundsSoFar(memberId) as [ChatRoundSoFar];
    // The reply from its first word, which took the paused words' place.
    expect(writing.reply).toBe('Done — the desk');
    expect(writing.held).toBeUndefined();
    expect(writing.workedMs).toEqual(expect.any(Number));
    expect(writing.steps).toEqual(LAMP_STEPS);

    midReply.open();
    await assistant.idle();
    // Over: its `turn` frame is all a page needs, and nothing is left to tell.
    expect(assistant.roundsSoFar(memberId)).toEqual([]);
  });

  it("names the newest answer before it, so a client can tell it from the round it was drawing", async () => {
    const play: { script?: Script } = {};
    const assistant = await assistantWith(play);
    const started = await assistant.start({ memberId, message: 'hello' });
    await assistant.idle();
    const rows = await assistant.transcript(started.sessionId);
    const answer = rows.findLast((row) => row.role !== 'user')!;
    expect(answer.role).toBe('agent');

    const held = gate();
    play.script = async (_text, context) => {
      context?.onStep?.('Thinking', 'thinking');
      context?.onThinking?.('Which lamp');
      await held.pass();
      return { kind: 'said', text: 'Done.' };
    };
    await assistant.reply(started.sessionId, memberId, 'and the lamp');
    await until(() => held.state.reached, 'the second round to begin');
    const [second] = assistant.roundsSoFar(memberId) as [ChatRoundSoFar];
    expect(second.since).toBe(answer.id);
    // Reasoning still arriving is its own field until a step takes it.
    expect(second.thinking).toBe('Which lamp');
    expect(second.steps).toEqual([{ text: 'Thinking', kind: 'thinking' }]);
    held.open();
    await assistant.idle();
  });

  it('stops answering the moment the round’s turn frame goes out — not after it is tidied away', async () => {
    const first = gate();
    const play: { script?: Script } = {
      script: async (text) => {
        if (text === 'first') await first.pass();
        return { kind: 'said', text: `Answered ${text}.` };
      },
    };
    const assistant = await assistantWith(play);
    const started = await assistant.start({ memberId, message: 'first' });
    const heard: Array<{ phase: string; answering: boolean }> = [];
    events.on('assistantChat', (event: AutomationChatEvent) => {
      if (event.sessionId !== started.sessionId || event.phase !== 'turn') return;
      heard.push({ phase: event.phase, answering: assistant.isAnswering(started.sessionId) });
    });
    await until(() => first.state.reached, 'the first round to begin');
    expect(assistant.isAnswering(started.sessionId)).toBe(true);

    // A message behind it is still to come when the first round lands…
    await assistant.reply(started.sessionId, memberId, 'second');
    first.open();
    await assistant.idle();
    // …and once the last round's frame is out, nothing is.
    expect(heard).toEqual([
      { phase: 'turn', answering: true },
      { phase: 'turn', answering: false },
    ]);
    expect(assistant.isAnswering(started.sessionId)).toBe(false);
  });
});

// ── The socket ───────────────────────────────────────────────────────────────

describe('the chatRound frame', () => {
  let handle: TestDb;
  let app: FastifyInstance;
  let engine: AutomationEngine;
  let idle: () => Promise<void>;
  let port: number;
  let token: string;
  let otherToken: string;
  const play: { script?: Script } = {};

  const auth = (bearer: string) => ({ authorization: `Bearer ${bearer}` });

  beforeAll(async () => {
    handle = (await openTestDb())!;
    await resetDb(handle.db);
    const db = handle.db;
    const dir = mkdtempSync(path.join(tmpdir(), 'gethome-chat-round-'));
    const events = new HubEventBus();
    const access = await loadedAccess(db, events);
    const pairing = new PairingService(db, dir, log, access);
    await pairing.boot();
    const activity = new ActivityService(db, events);
    const registry = new DeviceRegistry(db, events, activity, log);
    const settings = new SettingsService(db, Buffer.alloc(32).toString('base64'));
    await settings.setAiKey('anthropic', 'sk-ant-api03-test');
    const started = await startedAutomations(db, events, registry, activity, {
      settings,
      access,
      createConversation: () => standIn({}) as unknown as AutomationConversation,
      createAssistantConversation: () => standIn(play) as AgentConversation<AssistantTurn>,
    });
    engine = started.engine;
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
      home: await bootedHome(db, 'Round Hub'),
      hubId: 'hub-chat-round-test',
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
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    port = typeof address === 'object' && address ? address.port : 0;

    const code = readFileSync(path.join(dir, 'pairing-code'), 'utf8').trim();
    const claimed = await app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      payload: { code, memberName: 'Georgy', deviceName: 'iPhone' },
    });
    token = (claimed.json() as { token: string }).token;
    const invite = await app.inject({ method: 'POST', url: '/api/v1/invites', headers: auth(token), payload: {} });
    const joined = await app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      payload: { code: (invite.json() as { code: string }).code, memberName: 'Kolya' },
    });
    otherToken = (joined.json() as { token: string }).token;
  });

  afterAll(async () => {
    await engine?.stop();
    await app?.close();
    await handle?.close();
  });

  /** A socket subscribed to the conversations, keeping every frame it hears. */
  async function subscribed(bearer: string) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws?token=${bearer}`);
    const frames: Array<{ type: string; chat?: AutomationChatEvent; chatRound?: ChatRoundSoFar }> = [];
    socket.on('message', (data) => frames.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });
    socket.send(JSON.stringify({ type: 'subscribe', streams: ['automations'] }));
    await until(() => frames.some((frame) => frame.type === 'subscribed'), 'the subscription');
    return { socket, frames };
  }

  it('is sent to a socket that subscribes part-way, ahead of everything else of the round', async () => {
    const atWork = gate();
    const midReply = gate();
    play.script = lampRound(atWork, midReply);
    const started = await app.inject({
      method: 'POST',
      url: '/api/v1/assistant/chat',
      headers: auth(token),
      payload: { message: 'desk lamp on please' },
    });
    expect(started.statusCode).toBe(201);
    const { sessionId } = started.json() as { sessionId: string };
    atWork.open();
    await until(() => midReply.state.reached, 'the reply to begin');

    // The phone comes back with the reply half-written.
    const mine = await subscribed(token);
    const theirs = await subscribed(otherToken);
    const round = mine.frames.find((frame) => frame.type === 'chatRound')?.chatRound;
    expect(round).toMatchObject({ surface: 'assistant', sessionId, reply: 'Done — the desk' });
    expect(round?.steps).toEqual(LAMP_STEPS);

    midReply.open();
    await idle();
    const ofRound = (frames: typeof mine.frames) =>
      frames
        .filter((frame) => frame.type === 'chatRound' || frame.chat?.sessionId === sessionId)
        .map((frame) => (frame.type === 'chatRound' ? 'chatRound' : `${frame.chat?.phase}:${frame.chat?.text}`));
    await until(() => ofRound(mine.frames).includes('turn:said'), 'the round to land on the socket');
    // The snapshot, then the words it did not yet hold, then the end — nothing
    // missed and nothing twice.
    expect(ofRound(mine.frames)).toEqual(['chatRound', 'delta: lamp is on.', 'turn:said']);
    // Somebody else in the home hears the frames, as ever, and no snapshot of a
    // conversation that is not theirs.
    await until(() => ofRound(theirs.frames).includes('turn:said'), "the other socket's frames");
    expect(theirs.frames.some((frame) => frame.type === 'chatRound')).toBe(false);

    // Nothing is running now, so a socket subscribing now is told nothing.
    const later = await subscribed(token);
    expect(later.frames.some((frame) => frame.type === 'chatRound')).toBe(false);
    for (const socket of [mine.socket, theirs.socket, later.socket]) socket.close();
  });
});
