import { eq } from 'drizzle-orm';
import { members } from '../db/schema.js';
import type { AiRunKind } from '../core/ai-runs.js';
import type { AccessService } from '../core/access.js';
import type { ActivityService } from '../core/activity.js';
import type { AutomationEngine } from '../automations/engine.js';
import type { HubCommand } from '../schema/index.js';
import { effectiveAssistantModel } from './models.js';
import type { AssistantTurn } from './assistant-agent.js';
import type { AssistantToolContext, DelegateOutcome } from './assistant-tools.js';
import { delegateAgents, type DelegateAgent } from './agents/registry.js';
import type { AutomationChat } from './automation-chat.js';
import {
  AgentNotConfiguredError,
  ChatRuntime,
  type AgentConversation,
  type AgentSurface,
  type ChatMessageWire,
  type ChatRuntimeOptions,
  type ChatSession,
} from './chat/chat-runtime.js';

/**
 * The conversation behind the assistant button.
 *
 * Everything about *having* a conversation is `ChatRuntime`'s and is shared
 * with the automations agent. What is here is this agent's own: the model it
 * runs on, the tools that reach the home, and the one turn arm nothing else
 * has — a job handed to another agent.
 *
 * **The handoff is the interesting part, and it is deliberately thin.** What
 * crosses between the two agents is a written brief and a session id. The
 * assistant never sees the other agent's tool calls, its reasoning or its
 * transcript, which is the whole reason a second agent exists: this
 * conversation's context stays the size of a conversation however many agents
 * there come to be, and the rules each agent has to be told stay its own.
 *
 * What comes *back* is a status on a row, written by this class rather than by
 * a round with the model — so the assistant is never re-entered for a job it
 * has already handed on. A person reopening the chat next week reads
 * "delivered · 2 rules" rather than a spinner frozen mid-sentence.
 */

/** What a handoff row carries, and what the app draws a card from. */
export interface HandoffPayload {
  agent: string;
  title: string;
  brief: string;
  /** The other agent's conversation. The app follows this for the live trail,
   *  the questions and the cards. */
  sessionId: string;
  /** working · asked · delivered · failed. An open string: an app that meets
   *  a word a later build adds still draws the card and its brief. */
  status: string;
  /**
   * The rules it wrote for **this** job, once it has written any.
   *
   * Scoped to the job rather than to the conversation, since one conversation
   * can hold two — see `standingOf`. Nothing draws it today; it is what tells
   * a status apart from the same status with one more rule under it.
   */
  automationIds: string[];
}

export interface AssistantChatOptions extends ChatRuntimeOptions {
  access: AccessService;
  activity: ActivityService;
  /**
   * Just enough of the registry to work a device.
   *
   * Narrowed to the one method rather than taking `DeviceRegistry`, because
   * that is genuinely all this needs: the device's *name* comes from the home
   * view the assistant is already reading, so there is no second lookup and no
   * second thing that could disagree about what a device is called.
   */
  registry: { execute(deviceId: string, endpointId: number, command: HubCommand): Promise<void> };
  engine: AutomationEngine;
  /** The agent a job can be handed to, and the store its status is read from. */
  automationChat: AutomationChat;
  /** Overridden in tests, so the suite never reaches a provider. */
  createConversation?: (input: {
    modelId: string;
    secret: string;
    systemPrompt: string;
    taskPrompt: string;
  }) => AgentConversation<AssistantTurn>;
}

export class AssistantChat extends ChatRuntime<AssistantTurn> {
  protected readonly surface: AgentSurface = 'assistant';
  protected readonly eventName = 'assistantChat' as const;
  protected readonly runKind: AiRunKind = 'assist';
  protected readonly runAdapter = 'assistant';

  private readonly delegates: DelegateAgent[];
  /**
   * Delegated conversations this chat is following, by the *other* agent's
   * session id.
   *
   * In memory, and that is honest rather than a shortcut: what it holds is
   * "which row to amend while both are alive". The row itself carries the
   * session id, so a hub that restarts loses only the live status updates —
   * the card still names the conversation and the app can read it directly.
   */
  private readonly delegated = new Map<
    string,
    {
      messageId: string;
      payload: HandoffPayload;
      /**
       * **Which of *this* agent's conversations the card is in.**
       *
       * Absent, and the frame saying the card had moved went out under the
       * delegated session's id — so an app dutifully re-read the *other*
       * conversation, where nothing had changed, and the card sat on "working"
       * until somebody closed the page and came back. The row is on this
       * transcript; this is the transcript to say so about.
       */
      chatId: string;
    }
  >();

  constructor(private readonly options: AssistantChatOptions) {
    super(options);
    this.delegates = delegateAgents({ automationChat: options.automationChat });
    // The other agent's own frames say when one of its turns has landed.
    // Nothing is polled and nothing new is emitted: this is the same `turn`
    // frame the app is already drawing from.
    options.events.on('automationChat', (event) => {
      if (event.phase !== 'turn') return;
      void this.followDelegated(event.sessionId).catch(() => undefined);
    });
  }

  // ── The handoff ────────────────────────────────────────────────────────────

  /**
   * Hand a job over, and answer before it has done any of it.
   *
   * **The permission is asked here rather than when the prompt is built.** A
   * guest gets a sentence the model reads out and can act on — "ask somebody
   * who can" — where a tool that had been silently withheld would leave the
   * model insisting it cannot help with no reason it could give. The
   * `RoleNotice` rule, one layer down.
   */
  private async delegate(input: {
    memberId: string;
    sessionId: string;
    agentKey: string;
    brief: string;
    fresh?: boolean | undefined;
  }): Promise<DelegateOutcome> {
    const { memberId, sessionId, agentKey, brief } = input;
    const agent = this.delegates.find((entry) => entry.key === agentKey);
    if (!agent) {
      return {
        sessionId: '',
        text: '',
        refused: `There is no agent called "${agentKey}" on this hub.`,
      };
    }
    if (!this.options.access.can(memberId, agent.permission)) {
      return {
        sessionId: '',
        text: '',
        refused:
          `Their role cannot do that — it needs "${agent.permission}". Say so, and that ` +
          'somebody who manages the home can change it in People & access.',
      };
    }

    /**
     * **A follow-up goes back to the conversation that did the work.**
     *
     * Every handover used to open a fresh one, so "now make it 11:30 instead"
     * reached an agent that had never heard of the rule it had written five
     * seconds earlier — and paid to read the home again to work out what was
     * being talked about. Carrying on is the default for that reason: the
     * failure it prevents (an agent with no idea what "it" is) is worse than
     * the one it risks (an agent carrying a little history it does not need),
     * and the model says `fresh` for a job that genuinely starts over.
     *
     * The session is **read back off this conversation's own rows** rather
     * than remembered in a map — the `standingOf` rule: the transcript is the
     * truth about what was handed over, and it survives the restart that a map
     * would not.
     */
    const carryOn = input.fresh === true ? undefined : await this.lastHandedTo(sessionId, agentKey);
    if (carryOn !== undefined && (await agent.resume({ memberId, sessionId: carryOn, brief }))) {
      /**
       * **The old card stops speaking the moment the job moves on.**
       *
       * It is still the tracked row until this turn writes its own, and the
       * other agent starts work at once — so without this the card that asked
       * for the *last* thing was amended with the standing of the *new* one,
       * and a job that had delivered a rule went back to reading "working"
       * seconds later. Untracked, it keeps the last thing that was true of it,
       * which is what a record is for.
       */
      this.delegated.delete(carryOn);
      return {
        sessionId: carryOn,
        text:
          `Passed on to the ${agent.title}, which already had this job and still has ` +
          'everything it learned. It is working on it now, in the same conversation — the ' +
          'person can see what it is doing and answer it directly. Tell them briefly what you ' +
          'passed on, and do not describe the result: you will not see one.',
      };
    }

    const started = await agent.start({ memberId, brief });
    return {
      sessionId: started.sessionId,
      text:
        `Handed to the ${agent.title}. It is working on it now, in its own conversation — the ` +
        'person can see what it is doing and answer it directly. Tell them briefly what you ' +
        'passed on, and do not describe the result: you will not see one.',
    };
  }

  /**
   * The conversation this chat last handed to that agent, if it has.
   *
   * Off the transcript, newest first. A `handoff` row is the only record of a
   * handover and it carries both halves — which agent, and which session — so
   * there is nothing to keep in step.
   */
  private async lastHandedTo(sessionId: string, agentKey: string): Promise<string | undefined> {
    const rows = await this.transcript(sessionId);
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (row?.role !== 'handoff') continue;
      const data = row.data as { agent?: string; sessionId?: string } | undefined;
      if (data?.agent === agentKey && typeof data.sessionId === 'string') return data.sessionId;
    }
    return undefined;
  }

  /**
   * Where a delegated conversation has got to, read off its own rows.
   *
   * **Derived rather than remembered**, the reason a rule's room is: the
   * sub-agent's transcript is the truth about what it did, and a second copy
   * here would be a second thing to keep in step. Most specific first, the
   * `diagnosis.ts` rule — a conversation that has written a rule *and* gone on
   * to ask something is still asking.
   */
  private async standingOf(
    sessionId: string,
  ): Promise<{ status: string; automationIds: string[] }> {
    const all = await this.options.automationChat.transcript(sessionId);
    /**
     * **The job, not the conversation.** A follow-up goes back to the agent
     * that already has the work, so one conversation can hold two jobs — and
     * read whole, the second card was born saying "delivered" over the *first*
     * job's rule, and then never moved, because the guard below saw a status
     * and a count that had not changed. The current job starts at the last
     * thing said *to* it, which is the brief that opened it.
     */
    const opened = all.map((row) => row.role).lastIndexOf('user');
    const rows = opened < 0 ? all : all.slice(opened + 1);
    const automationIds = rows
      .filter((row) => row.role === 'preview')
      .map((row) => (row.data as { automationId?: string } | undefined)?.automationId)
      .filter((id): id is string => typeof id === 'string');
    const last = rows.at(-1);
    const status =
      last?.role === 'question'
        ? 'asked'
        : automationIds.length > 0
          ? 'delivered'
          : last?.role === 'note'
            ? 'failed'
            : 'working';
    return { status, automationIds };
  }

  /** A delegated conversation has finished a turn — say so on the card. */
  private async followDelegated(sessionId: string): Promise<void> {
    const tracked = this.delegated.get(sessionId);
    if (!tracked) return;

    const { status, automationIds } = await this.standingOf(sessionId);
    const payload: HandoffPayload = { ...tracked.payload, status, automationIds };
    // Unchanged is not worth a write, and this fires on every turn the other
    // agent takes.
    if (status === tracked.payload.status && automationIds.length === tracked.payload.automationIds.length) {
      return;
    }
    this.delegated.set(sessionId, { ...tracked, payload });
    await this.amend(tracked.messageId, payload);
    /**
     * The card is on **this** conversation's transcript, so this is the
     * conversation to say it moved about — and `amend` rather than `turn`,
     * because nothing here is a round of it ending.
     *
     * Both halves were wrong and each on its own was enough to break it. The
     * id was the delegated session's, so an app re-read the conversation where
     * nothing had changed and left the card on "working" until the page was
     * closed and reopened. And `turn` means "a round finished": this can land
     * at any moment, including while somebody is mid-question here, and it
     * would have taken that round's trail down with it.
     */
    this.emit({
      sessionId: tracked.chatId,
      phase: 'amend',
      at: new Date().toISOString(),
      text: 'handoff',
    });
  }

  /** The prose, then a card per job handed over. */
  protected async recordAgentTurn(
    session: ChatSession<AssistantTurn>,
    turn: AssistantTurn,
  ): Promise<ChatMessageWire[]> {
    if (turn.kind !== 'handed') return [];

    const messages: ChatMessageWire[] = [];
    if (turn.text.trim().length > 0) {
      messages.push(await this.write(session, 'agent', turn.text));
    }
    for (const handoff of turn.handoffs) {
      const agent = this.delegates.find((entry) => entry.key === handoff.agent);
      /**
       * **Read once here as well as on every later frame.** The other agent
       * starts the moment `delegate` returns and this row is written when the
       * assistant's turn *ends* — which can be several rounds later, and it
       * only takes one for a quick sub-agent to have already asked something.
       * Written as `working` regardless, the card would then sit on a stale
       * word until that agent next spoke, which for one waiting on an answer
       * is for ever.
       */
      const standing = await this.standingOf(handoff.sessionId);
      const payload: HandoffPayload = {
        agent: handoff.agent,
        title: agent?.title ?? handoff.agent,
        brief: handoff.brief,
        sessionId: handoff.sessionId,
        ...standing,
      };
      const row = await this.write(session, 'handoff', handoff.brief, payload);
      // **The newest row for that session wins**, which is what makes a
      // follow-up work: a second handover to the same conversation writes a
      // second card, and the status belongs to the one somebody is looking at
      // rather than to the one scrolled off the top.
      this.delegated.set(handoff.sessionId, {
        messageId: row.id,
        payload,
        chatId: session.id,
      });
      messages.push(row);
      session.produced += 1;
    }
    // A conversation that has handed something over has done its job; the
    // ledger row now rather than in two hours means an abandoned tab does not
    // hold it.
    if (turn.handoffs.length > 0) await this.record(session, true);
    return messages;
  }

  // ── Provider ───────────────────────────────────────────────────────────────

  /**
   * Build the conversation, refusing before the network is touched.
   *
   * The same three refusals the automations agent has, and for the same
   * reasons — a home with no key, the owner's switch, and a key of the wrong
   * kind. They carry the same codes because both apps already branch on them.
   */
  protected async openConversation(input: {
    memberId: string;
    topic: string | undefined;
    sessionId: string;
  }): Promise<AgentConversation<AssistantTurn>> {
    const ai = await this.options.settings.getAiSettings();
    if (!ai.enabled) throw new AgentNotConfiguredError('ai_disabled');
    if (!ai.hasKey) throw new AgentNotConfiguredError('ai_not_configured');
    if (!ai.anthropic.hasKey || ai.legacySubscriptionToken) {
      throw new AgentNotConfiguredError(
        'automation_needs_anthropic',
        'The assistant needs an Anthropic key at the moment. Add one in the home’s AI ' +
          'settings; device portraits and recognition carry on using OpenAI.',
      );
    }
    const secret = await this.options.settings.aiKey('anthropic');
    if (!secret) throw new AgentNotConfiguredError('ai_not_configured');

    // What will *run*, never the stored column — the one gap that cost the
    // mapper a release, and `getAiSettings` has already closed it here.
    const modelId = effectiveAssistantModel(ai.assistant.model);

    // Imported here rather than at the top, the `lazy.ts` seam: a hub nobody
    // has talked to never loads the SDK.
    const [{ assistantSystemPrompt, assistantTaskPrompt }] = await Promise.all([
      import('./assistant-prompts.js'),
    ]);
    const systemPrompt = assistantSystemPrompt(this.delegates);
    const taskPrompt = assistantTaskPrompt({
      home: this.options.engine.homeView(),
      timezone: this.options.settings.timezone,
    });

    /**
     * The test seam, **after** every configuration check.
     *
     * It stands in for the network, not for the rules. Above the checks it is
     * a bypass — a suite reaching a conversation the real hub would have
     * refused, which is the "a mock laxer than the thing it stands in for
     * tests the mock" trap, and exactly how the automations agent's refusal
     * shipped untested and reached a phone as a 500.
     */
    if (this.options.createConversation) {
      return this.options.createConversation({ modelId, secret, systemPrompt, taskPrompt });
    }

    const { createAssistantConversation } = await import('./assistant-agent.js');
    return createAssistantConversation({
      auth: { secret },
      modelId,
      systemPrompt,
      taskPrompt,
      log: this.options.log,
      tools: this.toolContext(input.memberId, input.sessionId),
    });
  }

  /**
   * What the tools can reach.
   *
   * **The member is closed over**, and that is load-bearing twice. A command
   * goes into the activity log with a name, and "the assistant did it" is not
   * a name anybody in the home could act on — somebody asked for it, and the
   * feed is read a week later. And a handover is refused or allowed by *that
   * member's* role, which is a question only this conversation can answer.
   */
  private toolContext(memberId: string, sessionId: string): AssistantToolContext {
    return {
      home: () => this.options.engine.homeView(),
      timezone: () => this.options.settings.timezone,
      stateOf: (deviceId, endpointId) => this.options.engine.stateFor(deviceId, endpointId),
      control: async (deviceId, endpointId, command) => {
        await this.control(memberId, deviceId, endpointId, command);
      },
      runAutomation: async (id) =>
        this.options.engine.runManually(id, (await this.memberName(memberId)) ?? 'the assistant'),
      delegate: async (agent, brief, fresh) =>
        this.delegate({ memberId, sessionId, agentKey: agent, brief, fresh }),
      delegates: this.delegates.map((agent) => ({
        key: agent.key,
        title: agent.title,
        description: agent.description,
      })),
    };
  }

  /**
   * Work a device, and write it down.
   *
   * Through the registry's ordinary command path — already serialised per
   * device, already the one place a command reaches an adapter — and into the
   * activity log as `device.command`, which is the log's own rule: it records
   * what was *asked*. A command nobody can see the origin of is the one thing
   * an agent with a relay must not produce.
   */
  private async control(
    memberId: string,
    deviceId: string,
    endpointId: number,
    command: HubCommand,
  ): Promise<void> {
    await this.options.registry.execute(deviceId, endpointId, command);
    const device = this.options.engine.homeView().devices.find((entry) => entry.id === deviceId);
    const name = (await this.memberName(memberId)) ?? 'Somebody';
    await this.options.activity.record({
      kind: 'device.command',
      // **Named for the person, not for the agent.** They asked for it, the
      // feed is read a week later, and "the assistant" is not somebody anyone
      // in the home can go and ask about it. `via` says how it was asked, for
      // an app that wants to draw the difference.
      message: `${name} · ${device?.name ?? deviceId}: ${command.type}`,
      ...(device !== undefined ? { deviceId: device.id } : {}),
      memberId,
      data: {
        command,
        deviceName: device?.name ?? deviceId,
        memberName: name,
        via: 'assistant',
      },
    });
  }

  /** The member's own name, for anything written in the home's voice. */
  private async memberName(memberId: string): Promise<string | undefined> {
    const row = await this.options.db.query.members.findFirst({ where: eq(members.id, memberId) });
    return row?.name;
  }
}
