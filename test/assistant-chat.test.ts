import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { HubEventBus } from '../src/core/bus.js';
import { ActivityService } from '../src/core/activity.js';
import { AiRunLog } from '../src/core/ai-runs.js';
import { AccessService } from '../src/core/access.js';
import { SettingsService } from '../src/core/settings.js';
import {
  activity as activityTable,
  members as membersTable,
  roles as rolesTable,
} from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { openTestDb, resetDb, startedAutomations, type TestDb } from './helpers/db.js';
import { AssistantChat } from '../src/ai/assistant-chat.js';
import { AutomationNotConfiguredError } from '../src/ai/automation-chat.js';
import type { AssistantTurn } from '../src/ai/assistant-agent.js';
import type { AgentConversation, ChatTurnContext } from '../src/ai/chat/chat-runtime.js';
import type { AutomationConversation, AutomationTurn } from '../src/ai/automation-conversation.js';
import { ASSISTANT_MODELS, effectiveAssistantModel } from '../src/ai/models.js';

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
    },
  ) => Promise<{
    assistant: AssistantChat;
    automationChat: Awaited<ReturnType<typeof startedAutomations>>['chat'];
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
        listDevices: () => [],
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
        modelId: 'claude-opus-5',
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
      const round = async (_text: string, context?: ChatTurnContext): Promise<AssistantTurn> => {
        const at = index;
        index += 1;
        context?.onStep?.('Reading your home', 'thinking');
        await options?.gate;
        return turns[at] ?? { kind: 'said', text: 'nothing left to say' };
      };
      const scripted: AgentConversation<AssistantTurn> = {
        provider: 'anthropic',
        modelId: 'claude-opus-5',
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
      return { assistant, automationChat };
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
    // The gap that cost the mapper a release: every surface that *reported* a
    // model went through `effectiveModel` while the call that picked one to
    // run read the stored column.
    expect(effectiveAssistantModel(null)).toBe(ASSISTANT_MODELS.default);
    expect(effectiveAssistantModel('claude-sonnet-5')).toBe('claude-sonnet-5');
    // A model this build no longer offers is stored happily and is simply not
    // what runs — silently keeping a home on a retired one is the failure.
    expect(effectiveAssistantModel('claude-opus-4-6')).toBe(ASSISTANT_MODELS.default);

    await settings.setAssistantModel('claude-sonnet-5');
    expect((await settings.getAiSettings()).assistant.model).toBe('claude-sonnet-5');
  });

  it('works a device through the registry and names the person in the log', async () => {
    const { assistant } = await assistantFor([{ kind: 'said', text: 'Done.' }]);
    const started = await assistant.start({ memberId, message: 'lights on' });
    await assistant.idle();

    // The tool context is what the agent is handed; the scripted conversation
    // never calls it, so this exercises the same path the loop would.
    const tools = (
      assistant as unknown as { toolContext: (id: string) => { control: (...args: never[]) => Promise<void> } }
    ).toolContext(memberId);
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
        toolContext: (id: string) => {
          delegate: (agent: string, brief: string) => Promise<{ sessionId: string; refused?: string }>;
        };
      }
    ).toolContext(memberId);

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
        toolContext: (id: string) => {
          delegate: (agent: string, brief: string) => Promise<{ sessionId: string }>;
        };
      }
    ).toolContext(memberId);
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
