import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { members } from '../db/schema.js';
import type { AiRunKind } from '../core/ai-runs.js';
import type { AccessService } from '../core/access.js';
import type { ActivityService } from '../core/activity.js';
import type { AutomationEngine } from '../automations/engine.js';
import type { AiProvider } from '../core/settings.js';
import type { HubCommand } from '../schema/index.js';
import type { AssistantTurn } from './assistant-agent.js';
import type { AssistantToolContext, DelegateOutcome } from './assistant-tools.js';
import { delegateAgents, type DelegateAgent } from './agents/registry.js';
import type { DecisionTransport } from './decide/connection.js';
import type { Decider } from './decide/decider.js';
import { lazyDecider } from './decide/lazy.js';
import {
  decideHomeCommand,
  decideParts,
  describeStandDown,
  leftNothing,
  participle,
  phrase,
  type CommandPlan,
  type DecidableHome,
  type DeviceAction,
  type HomeDecision,
  type StandDown,
} from './decide/home-command.js';
import {
  SPECULATION_REUSE_MS,
  SPECULATION_TIMEOUT_MS,
  SPECULATION_WAIT_MS,
} from './decide/questions.js';
import type { SplitInput, SplitResult } from './decide/split.js';
import { LIVE_MODEL, LIVE_USD_PER_MINUTE, SIDEBAND_MAX_SECONDS } from './voice/live-wire.js';
import type { AutomationChat } from './automation-chat.js';
import {
  AgentNotConfiguredError,
  ChatRuntime,
  type AgentConversation,
  type AgentSurface,
  type TurnOrigin,
  type ChatVia,
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
    provider: AiProvider;
    modelId: string;
    secret: string;
    systemPrompt: string;
    taskPrompt: string;
  }) => AgentConversation<AssistantTurn>;
  /**
   * What carries a decision to the vendor. Overridden in tests, which stand in
   * for the network and nothing else — every rule about what a reading means
   * still runs.
   */
  decisionTransport?: DecisionTransport;
  /** Overridden in tests: the generative split of a sentence that is several requests. */
  splitRequest?: (input: SplitInput) => Promise<SplitResult | null>;
}

/**
 * The most devices the fast path works at once.
 *
 * A group is carried out device by device through `control`, and "every light
 * in the house" all at once is forty writes queued on one radio in the same
 * instant. A few at a time finishes in about the same wall-clock time and is a
 * queue a Zigbee network can take.
 */
const FAST_PATH_CONCURRENCY = 6;

/** What happened to one device the fast path worked. */
interface ActionOutcome {
  action: DeviceAction;
  /** Why it did not take it, in the adapter's own words. Absent when it did. */
  error?: string;
}

/** What the fast path hands back to `ChatRuntime` for the round it runs next — see `beforeRound`. */
type BeforeRound = { origin?: TurnOrigin; turn?: AssistantTurn } | undefined;

/**
 * Two readings of the same sentence, give or take punctuation and case.
 *
 * **The whole rule for reusing a speculation, and it is equality rather than
 * a prefix.** It used to be `startsWith`, on the reasoning that carrying on
 * talking produces a superset of what was read — and a superset is exactly
 * where the meaning changes: "turn the bedroom light on" read while somebody
 * was still saying "— no, off" was acted on as *on*, and "turn off the kitchen
 * light" read before "and the hall light" moved one light of two. What a
 * speculation buys now is the open connection, the session and the digest —
 * and its reading, when the sentence turned out to be the one it read.
 */
function sameSentence(a: string, b: string): boolean {
  const normal = (text: string) =>
    text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\p{P}\p{S}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  return normal(a) === normal(b);
}

/** A wait nothing has to cancel, and that keeps no process alive. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * The longest a voice session may be billed for here, in seconds.
 *
 * A bound on a number rather than a policy about how long anybody may talk,
 * and the one it has to agree with is the sideband's own ceiling — that socket
 * is what reads the usage, so nothing can report more than it stayed attached
 * for. It said half an hour against the sideband's hour for a while, on a
 * reason that has since gone (an ephemeral client secret that expired inside
 * thirty minutes, from the design WebRTC replaced), which would have silently
 * under-reported a long conversation.
 *
 * `SIDEBAND_MAX_MS` is the number; this is it in seconds, with the same job an
 * unbounded figure could not do — keeping a wrong number out of the home's
 * ledger.
 */
const VOICE_MAX_SECONDS = SIDEBAND_MAX_SECONDS;

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

  /**
   * The fast decision model, or a stand-in that always answers "no answer".
   *
   * Built once and asked every turn, because the credential check is inside
   * it: a key saved this afternoon works this afternoon, with no restart.
   */
  private readonly decider: Decider;

  /**
   * What the fast path has already carried out this turn, per conversation.
   *
   * The model is told the command is done, but a prompt is a request rather
   * than a guarantee — and the one failure that matters here is the lamp going
   * off twice, which reads as the hub having a stutter. So the record is kept
   * and `control` refuses a repeat rather than relying on the sentence.
   */
  private readonly actedThisTurn = new Map<string, Set<string>>();

  /**
   * What a sentence still being said has already been read as.
   *
   * Kept so the real turn can use it when the finished sentence turns out to
   * be *the same sentence* (`sameSentence`) — which is often the case, since
   * the voice asks for help a beat after somebody stops, and the last partial
   * read is usually the whole of what they said.
   */
  private readonly speculated = new Map<
    string,
    { partial: string; decision: HomeDecision; at: number }
  >();

  /**
   * A speculation still out, per conversation.
   *
   * The real turn waits for it briefly (`SPECULATION_WAIT_MS`): it is holding
   * the one open connection, and it may have read exactly this sentence — so
   * a short wait is usually faster than a second request beside it.
   */
  private readonly pendingSpeculation = new Map<string, Promise<void>>();

  constructor(private readonly options: AssistantChatOptions) {
    super(options);
    this.delegates = delegateAgents({ automationChat: options.automationChat });
    this.decider = lazyDecider({
      settings: options.settings,
      log: options.log,
      ...(options.decisionTransport !== undefined ? { transport: options.decisionTransport } : {}),
    });
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
   * The reading a partial sentence already produced, when it was a reading of
   * this very sentence.
   *
   * **Equality, never a prefix** — see `sameSentence` for the two ways a
   * prefix went wrong. Anything else is a miss, and a miss simply decides live
   * on the connection the speculation left open, which is most of what it was
   * for.
   *
   * Consumed once. A second turn must not be answered from a reading of the
   * first, however alike the two happen to be.
   */
  private reuseSpeculation(sessionId: string, text: string): HomeDecision | undefined {
    const cached = this.speculated.get(sessionId);
    if (cached === undefined) return undefined;
    this.speculated.delete(sessionId);
    if (!sameSentence(text, cached.partial)) return undefined;
    if (Date.now() - cached.at > SPECULATION_REUSE_MS) return undefined;
    return cached.decision;
  }

  /**
   * The home, as a reading needs it — the catalog, and what each device
   * reports now, for "brighter" and "warmer".
   */
  private decidableHome(): DecidableHome {
    const view = this.options.engine.homeView();
    return {
      rooms: view.rooms,
      zones: view.zones,
      devices: view.devices,
      stateOf: (deviceId, endpointId) => this.options.engine.stateFor(deviceId, endpointId),
    };
  }

  /**
   * Somebody has opened the assistant, or started talking to it: get the
   * decision connection ready.
   *
   * **The first sentence was the slow one.** Nothing had reached the vendor
   * for minutes, so the connection a decision needs was closed and the first
   * thing said paid for DNS, TCP and TLS from a Pi before the question was
   * even sent — which is most of what "Jev didn't answer in time" was. Opening
   * it while somebody is still reading the page costs nothing they can see.
   *
   * Fire-and-forget, and it never throws: the warm-up decides for itself
   * whether there is a key, whether decisions are on and whether a connection
   * is already open.
   */
  prepare(): void {
    void this.decider.warm?.().catch(() => undefined);
  }

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
    /**
     * **Whose key answers, and what runs on it — both from `getAiSettings`.**
     *
     * This used to refuse anything but Anthropic outright, which was honest
     * while only that loop was written and is now simply wrong: a home with an
     * OpenAI key runs on it. What is left of that refusal is the one case it
     * was always really about — a stored Anthropic *subscription token*, which
     * is a credential the hub holds and cannot use, with no OpenAI key beside
     * it. The code stays because both apps branch on it; the sentence says the
     * true thing now.
     */
    const provider = ai.assistant.provider;
    if (provider === null) {
      throw new AgentNotConfiguredError(
        'automation_needs_anthropic',
        'The key saved for this home can’t be used to talk to a model — a Claude subscription ' +
          'token is not an API key. Add an Anthropic or OpenAI API key in the home’s AI settings.',
      );
    }
    const secret = await this.options.settings.aiKey(provider);
    if (!secret) throw new AgentNotConfiguredError('ai_not_configured');

    // What will *run*, never the stored column — the one gap that cost the
    // mapper a release, and `getAiSettings` has already closed it here.
    const modelId = ai.assistant.model;

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
      return this.options.createConversation({ provider, modelId, secret, systemPrompt, taskPrompt });
    }

    const { createAssistantConversation } = await import('./assistant-agent.js');
    return createAssistantConversation({
      auth: { secret },
      provider,
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
        // **Spoken or typed, asked at the moment of the command.** A
        // conversation is created once and can be both — typed this morning,
        // talked to this evening — so reading `spokenSessions` here rather
        // than closing over a value is what keeps the feed's own distinction
        // true in either direction. It used to be a parameter, which was fine
        // while the voice ran its own tools and wrong the moment the voice
        // started reaching the assistant instead.
        await this.control(
          memberId,
          sessionId,
          deviceId,
          endpointId,
          command,
          this.spokenSessions.has(sessionId) ? 'voice' : 'assistant',
        );
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

  // ── The voice ──────────────────────────────────────────────────────────────

  /**
   * The conversation a voice session will fill in.
   *
   * **A plain id and nothing else**, which is the whole of why this is three
   * lines. A spoken exchange has no provider conversation on this hub — the
   * model is on the other end of the phone's own socket — so there is no
   * session object, no history in memory and nothing to sweep. What there *is*
   * is a transcript, written row by row as things are said, which is what makes
   * the page fill in while somebody talks.
   *
   * And it is the same kind of id as a typed conversation's, deliberately: open
   * the page afterwards and it is simply a chat, readable and continuable —
   * `revive()` rebuilds a model conversation from those rows, so typing a
   * follow-up to something you said out loud reaches an agent that has read it.
   *
   * `existing` is the app carrying one on — stopping and restarting the mic on
   * one page is one conversation, not two — and is simply handed back, since
   * there is no session object here for a second call to disturb.
   *
   * **Call it *after* the sideband is attached, never before, and only when one
   * is.** Attaching replaces whatever sideband this conversation was already
   * holding, and replacing one settles it — which is what *clears* the mark.
   * So marking first meant that stopping and starting the microphone quickly
   * (before `session.closed` had reached the hub) cleared the mark the new
   * session had just set, and every command spoken for the rest of that line
   * was written into the home's feed as typed. The other half is the same rule
   * pointed the other way: a session nothing attaches to is one nothing will
   * ever settle, so marking it leaves the conversation marked for the life of
   * the process and logs a typed follow-up as speech.
   */
  beginVoice(existing?: string): string {
    const sessionId = existing ?? randomUUID();
    this.spokenSessions.add(sessionId);
    return sessionId;
  }

  /**
   * May this member speak into that conversation?
   *
   * **`revive()`'s ownership guard, asked where it can still be answered
   * politely.** That guard refuses to rebuild somebody else's conversation, and
   * `askAloud` fell straight past it: a session id nobody here holds and cannot
   * revive reaches `open()`, which happily builds a *fresh* conversation under
   * that id and writes into the other person's transcript. Reading a home's
   * transcripts is shared by design; writing into one is not, and this is the
   * only route that takes a session id from a request body.
   *
   * An empty transcript is a fresh id — the ordinary case, and the one the app
   * is in every time it mints a conversation. Anything else has to be the
   * caller's own, which deliberately refuses an *orphaned* one too (the column
   * is `ON DELETE SET NULL`, so null means the person who had this conversation
   * has left the home) — the same answer `revive` gives it.
   */
  async maySpeakInto(sessionId: string, memberId: string): Promise<boolean> {
    const rows = await this.transcript(sessionId);
    if (rows.length === 0) return true;
    return (await this.ownerOf(sessionId)) === memberId;
  }

  /**
   * Conversations somebody is currently *talking* to.
   *
   * **One word in the activity log, and it is worth the set.** A command
   * somebody spoke and a command somebody typed are worth telling apart in a
   * feed read a week later, and since the voice stopped running its own tools
   * every spoken command arrives here as an ordinary assistant turn — so
   * without this, speaking became indistinguishable from typing in the one
   * place the difference is read.
   *
   * Marked when a session opens and cleared when the sideband settles, which
   * is every way a line can end that this process is still alive to see — the
   * session closing, the socket dropping, the ceiling, the hub letting go. It
   * is deliberately **not** hung off a session having reported what it cost:
   * usage arrives about once a minute, so the short sessions are exactly the
   * ones that end with no number, and clearing on the money would have left
   * the mark on precisely those.
   *
   * What is left is a hub killed outright mid-conversation, where the set goes
   * with the process.
   */
  private readonly spokenSessions = new Set<string>();

  /**
   * Ask the home something somebody said out loud, and wait for the answer.
   *
   * **This is the hub-side half of client delegation**, and it is what the
   * sideband calls when GPT-Live asks for help. It is deliberately the
   * *ordinary* path: `say()` writes the person's row, runs the round with every
   * tool the assistant has, and writes the answer — so a spoken exchange and a
   * typed one leave the same two rows, the same trail on the socket, and the
   * same conversation to carry on by typing.
   *
   * **One writer, which is the bug this fixed.** The phone used to write the
   * person's sentence itself *and* send it as a message, so every spoken
   * request landed in the transcript twice. Nothing writes rows here but the
   * round.
   *
   * **The wait is the runtime's, not a socket's.** The phone had to send a
   * message, subscribe, and resume a continuation when a `turn` frame came
   * back with the rows re-read — because it is on the other side of the LAN
   * from the thing doing the work. Here the conversation's own `inFlight` is
   * the answer, which is why this is ten lines and that was sixty.
   *
   * **And a session may not exist yet.** `beginVoice` mints an id before a word
   * is spoken, so the first question arrives at a conversation with no
   * transcript to revive from — hence `open`. Later questions find it in
   * memory, or revive it from its rows after a restart.
   */
  /**
   * What a spoken round works at, against `medium` for a typed one.
   *
   * **The same question costs differently out loud.** A typed answer is read
   * when it lands, so a few extra seconds of thinking buys a better one for
   * free; a spoken answer is a person standing in a room with nothing
   * happening, where the voice has already said "one moment" and the silence
   * after that is the whole experience. The work is also usually smaller than
   * it looks — "switch the kitchen light off" is one tool call against a
   * catalog the agent can already see — so what `medium` mostly buys here is
   * deliberation about a decision that was never in doubt.
   *
   * It is per **turn** rather than per conversation because one conversation
   * is both: typed in the morning, talked to in the evening. Deliberately not
   * a setting — see `ChatTransportOptions.effort` on why two knobs for one
   * decision is one too many.
   *
   * `via` rides with it for the same reason and lands in the same place: the
   * `ai_runs` row, where a spoken round would otherwise be indistinguishable
   * from a typed one — same `kind`, same agent, different effort, and a meter
   * running on the line beside it.
   */
  private static readonly spokenOrigin: TurnOrigin = { effort: 'low', via: 'voice' };

  /**
   * Get ready for a sentence that has not finished.
   *
   * **The expensive half of a spoken exchange happens before the answer, and
   * none of it depends on how the sentence ends.** Opening the conversation
   * reads the settings, decrypts the key, builds the transport and — the one
   * that actually costs on a Pi — imports the vendor client for the first
   * time. The state digest is a walk of the registry's cache. Doing all of it
   * while somebody is still talking is why the model can start the moment they
   * stop.
   *
   * **It cannot write, and that is structural rather than careful.** The three
   * things it does are open, digest and read; there is no call to `say`,
   * `askAloud`, `delegate` or `control` anywhere in it, and
   * `VoiceDelegationHost` is narrowed so the caller could not ask for one.
   *
   * And because the warm is a side effect on `this.sessions`, `askAloud`'s own
   * lookup simply hits when the real delegation arrives — so there is no
   * second parameter to thread and **no way for a warmed session to be the
   * wrong one**. A speculation that turned out to be about a different
   * sentence has left nothing behind but a conversation that exists, which is
   * what the next one needed anyway.
   */
  async warmForSpeech(input: {
    sessionId: string;
    memberId: string;
    partial: string;
  }): Promise<void> {
    const session =
      this.sessions.get(input.sessionId) ??
      (await this.revive(input.sessionId, input.memberId)) ??
      ((await this.maySpeakInto(input.sessionId, input.memberId))
        ? await this.open(input.sessionId, input.memberId)
        : null);
    if (session === null || session.memberId !== input.memberId) return;

    // The readings, gathered now so the round that follows has nothing to look
    // up. Replaced rather than appended on each speculation: the newest is the
    // true one, and stacking them would be the same digest several times.
    const { spokenStateDigest } = await import('./assistant-prompts.js');
    const digest = spokenStateDigest({
      home: this.options.engine.homeView(),
      stateOf: (deviceId, endpointId) => this.options.engine.stateFor(deviceId, endpointId),
    });
    if (digest !== undefined) session.priming = digest;

    /**
     * And the reading itself, **kept** for the turn that follows.
     *
     * `speculative`, so it is dropped when anything else is already out and
     * never stands in a real turn's way. It reads nothing that could write:
     * what is kept is a *reading*, and the write still happens on the real
     * turn, after the voice says the sentence is finished, through `control`
     * and past every guard. Its first job is the connection, which it opens
     * for the real turn whatever it concludes.
     */
    const reading = decideHomeCommand({
      decider: this.decider,
      home: this.decidableHome(),
      delegates: this.delegates,
      said: input.partial,
      timeoutMs: SPECULATION_TIMEOUT_MS,
      priority: 'speculative',
    });
    const settled = reading.then(
      () => undefined,
      () => undefined,
    );
    this.pendingSpeculation.set(input.sessionId, settled);
    try {
      const decision = await reading;
      session.decisionUsd += decision.costUsd;
      // A dropped speculation answers `none` at no cost; keeping that would
      // hand the real turn a "nothing to do" it never earned.
      if (decision.kind !== 'none' || decision.costUsd > 0) {
        this.speculated.set(input.sessionId, {
          partial: input.partial,
          decision,
          at: Date.now(),
        });
      }
    } finally {
      if (this.pendingSpeculation.get(input.sessionId) === settled) {
        this.pendingSpeculation.delete(input.sessionId);
      }
    }
  }

  async askAloud(input: {
    sessionId: string;
    memberId: string;
    question: string;
  }): Promise<string | null> {
    // **The last arm is the one that needed a guard.** A live session carries
    // its member and is compared below; a revived one refuses an owner that is
    // not the caller. `open()` refuses nothing — it is for the id `beginVoice`
    // minted, which has no transcript yet — so without `maySpeakInto` a
    // session id belonging to somebody else fell through to it and this round
    // wrote into their conversation. See the method for why that is not the
    // same question as reading one.
    const session =
      this.sessions.get(input.sessionId) ??
      (await this.revive(input.sessionId, input.memberId)) ??
      ((await this.maySpeakInto(input.sessionId, input.memberId))
        ? await this.open(input.sessionId, input.memberId)
        : null);
    if (session === null || session.memberId !== input.memberId) return null;

    /**
     * **The one thing this round needs to know that a typed one does not.**
     *
     * The system prompt carries the rules (see *SOMETIMES YOU ARE BEING SPOKEN
     * TO*) because it is byte-identical for the life of a build and therefore
     * free after the first round; this is the marker that turns them on, and
     * it is a line rather than a paragraph for exactly that reason.
     *
     * It rides on `ChatSession.priming`, the channel `revive()` already uses —
     * so it reaches the model and is *not* written down as a message, which
     * matters here more than anywhere: the row this turn writes is what the
     * person said out loud, and an instruction stapled to the front of it
     * would be read back on the page and spoken into the next round's history.
     */
    /**
     * **And what everything is doing right now**, which is the one thing the
     * cached first message cannot carry: it is written once and would be
     * answered from confidently an hour later. Built here, at the moment of
     * the turn, it costs a spoken read a whole model round — "is the kitchen
     * light on" was one round to call `get_device` and a second to say the
     * answer, which is a doubling of the term that dominates a spoken exchange
     * on most of what anybody asks a house. Prefill against decode: about a
     * thousand input tokens against one or two seconds of somebody standing in
     * a room. `spokenStateDigest` is where the bounds are.
     */
    // Loaded on demand, like `open()`'s call to the same module two hundred
    // lines down: this file's rule is that a prompt is not part of its graph.
    const { spokenStateDigest } = await import('./assistant-prompts.js');
    const digest = spokenStateDigest({
      home: this.options.engine.homeView(),
      stateOf: (deviceId, endpointId) => this.options.engine.stateFor(deviceId, endpointId),
    });
    for (const line of [AssistantChat.spokenPriming, digest]) {
      if (line === undefined) continue;
      session.priming = session.priming === undefined ? line : `${session.priming}\n${line}`;
    }

    const before = (await this.transcript(input.sessionId)).length;
    await this.say(session, input.question, 'auto', AssistantChat.spokenOrigin);
    try {
      await session.inFlight;
    } catch (error) {
      // The round's own failure is already an `agent` row and an `ai_runs`
      // entry; what matters here is not throwing into a socket handler.
      this.options.log.warn({ error }, 'voice: a spoken round failed');
    }
    const rows = await this.transcript(input.sessionId);
    for (let index = rows.length - 1; index >= before; index -= 1) {
      const row = rows[index];
      const said = row === undefined ? null : AssistantChat.spoken(row);
      if (said !== null) return said;
    }
    return null;
  }

  /** What one spoken round is told about itself. See `askAloud`. */
  private static readonly spokenPriming =
    'This turn was spoken aloud and your answer will be read out by a voice. ' +
    'Follow the spoken rules in your instructions.';

  /**
   * What the voice should say about a row this round wrote, or nothing.
   *
   * **A question is an answer.** This used to take `agent` and `note` rows
   * only, which is right for the two arms a typed reply usually ends in and
   * silently wrong for the third: `ask_user` is the tool the assistant's own
   * prompt sends it to whenever a request is ambiguous in a way that changes
   * what it would *do* — three lamps, the room or the house — which is the
   * commonest thing to be ambiguous about out loud. The row was skipped, the
   * scan fell off the end, and the person who had just asked for a light to be
   * turned off heard *"that could not be worked out"* while a perfectly good
   * question with two tappable options landed on a page in their pocket.
   *
   * **The options are folded into the sentence**, because the model writes
   * the choices into `options` and the question bare — "Which one?" is not a
   * question anybody can answer out loud. Speaking them is also what makes the
   * answer work: the reply comes back through `askAloud` as another spoken
   * turn, and `say(…, 'auto')` already routes it to `answer` because the
   * conversation is awaiting one.
   *
   * `preview` and `handoff` rows stay out: a rule's document and a brief
   * written from one agent to another are page furniture, and the `handoff`
   * arm writes its own `agent` row saying what was handed over.
   */
  private static spoken(row: ChatMessageWire): string | null {
    if (row.role === 'agent' || row.role === 'note') return row.text;
    if (row.role !== 'question') return null;
    const options = (row.data as { options?: { label?: unknown }[] } | undefined)?.options ?? [];
    const labels = options
      .map((option) => option.label)
      .filter((label): label is string => typeof label === 'string' && label.trim() !== '');
    if (labels.length === 0) return row.text;
    const last = labels[labels.length - 1]!;
    const spokenOptions =
      labels.length === 1 ? last : `${labels.slice(0, -1).join(', ')} or ${last}`;
    return `${row.text} ${spokenOptions}?`;
  }

  /**
   * The line has closed — and what it cost, when the session said.
   *
   * **Its own `ai_runs` row rather than an addition to the conversation's**,
   * because they are two meters and pretending otherwise would hide one:
   * GPT-Live bills for time on the line — including silence, and including the
   * seconds the backend is thinking — while the model behind it bills for
   * tokens and has already written its own `assist` rows. Summed, they are what
   * the conversation cost; apart, they answer *why*.
   *
   * **The duration is the session's own**, read off `session.usage.updated` /
   * `session.closed` by the sideband. It used to be a stopwatch on the phone,
   * which was the softest number in this ledger and gone entirely when
   * somebody force-quit; that went with the loop it belonged to.
   *
   * **And zero is a real argument.** Usage snapshots arrive about once a
   * minute, so a short session that dropped rather than closing carried no
   * number at all — and the call still has to happen, because clearing the
   * spoken mark is the other half of what this does and a conversation left
   * marked logs a typed follow-up as speech. No seconds, no row: `$0.00`
   * against a line that plainly ran is a claim, where nothing is the truth.
   */
  async recordVoiceSpend(input: { sessionId: string; seconds: number }): Promise<void> {
    // The line has closed, so a typed follow-up in this conversation is typed.
    this.spokenSessions.delete(input.sessionId);
    const seconds = Math.max(0, Math.min(input.seconds, VOICE_MAX_SECONDS));
    if (seconds <= 0) return;
    const handle = this.options.runs.begin({
      kind: 'voice',
      adapter: 'assistant',
      // Empty on purpose: this column is about a device model, and a
      // conversation is not about one.
      exposesHash: '',
      provider: 'openai',
      modelId: LIVE_MODEL,
      sessionId: input.sessionId,
      // The line itself. No `effort`: GPT-Live has no such setting, and a
      // number invented here would be the one field in this log that was
      // never true of anything.
      via: 'voice',
    });
    await handle.finish({
      ok: true,
      costUsd: (seconds / 60) * LIVE_USD_PER_MINUTE,
      durationMs: seconds * 1000,
    });
  }

  /**
   * Read the sentence before the model is asked, and act on what there is
   * nothing left to be unsure about.
   *
   * **This is the whole latency argument.** "Turn the kitchen light off" costs
   * two model rounds without it — one to call the tool, one to say it happened
   * — and the first of those is answering a question with one right answer
   * over a catalog the hub is holding in memory. A decision model answers it in
   * a few hundred milliseconds for a fiftieth of a penny, so the light moves
   * before the model has been asked anything, and the one round left is the
   * reply — run at the lowest effort, since it has nothing to work out.
   *
   * Three roads, which are the vendor's own smart-home demo:
   *
   * - **One thing to do, read confidently** — one device, or a set of them:
   *   "the kitchen light and the hall light", "all the lights downstairs" — is
   *   carried out here (`actOn`). When that was surely the whole message the
   *   round only says so; when a question came with it, or a device the
   *   reading was not sure about, the round does the rest.
   * - **Several different things** are split by the conversation's own model
   *   (`splitAhead`), the parts are read in one more request, and every part
   *   read confidently is carried out. What is left — a question, a rule, a
   *   part it was unsure of — is the model's.
   * - **Everything else** is the model's, exactly as it would have been, with
   *   the reason written down (`reportStandDown`).
   *
   * Whatever was carried out, the model is told precisely what, device by
   * device, and writes the reply itself (`fastPathPriming`).
   *
   * Four things it does **not** do, each deliberate:
   *
   * - It never writes the reply. A canned "All done" is words in the model's
   *   mouth — the rule the automations agent's own prose arm is built around.
   * - It never decides who may do something. Every command goes through
   *   `control`, the path the model's own tool takes, past the same guards and
   *   into the same activity row named for the person.
   * - It never lets the decision model read a number. A number somebody said
   *   is found in code and every calculation is code; the model says only what
   *   it is a number *of*.
   * - It never fast-paths an `answer`. That closes a `tool_use` the provider
   *   is waiting on, and a request carrying an unanswered call is refused.
   */
  protected override async beforeRound(
    session: ChatSession<AssistantTurn>,
    text: string,
    how: 'send' | 'answer',
    origin: TurnOrigin | undefined,
  ): Promise<{ origin?: TurnOrigin; turn?: AssistantTurn } | undefined> {
    this.actedThisTurn.set(session.id, new Set());
    if (how === 'answer') return undefined;
    /**
     * **The seam never throws, and this is what makes that true.** A throw
     * out of here is not a fallback — `exchange` catches it as a turn that
     * could not be saved, writes a note and runs no round at all, so a lookup
     * that failed on the way to a lamp would leave somebody with no answer.
     * Anything that goes wrong is the model's sentence, whole. Whatever was
     * already carried out stays carried out, and `actedThisTurn` makes the
     * model's own call for the same thing a no-op rather than a second switch.
     */
    try {
      return await this.fastPath(session, text, origin);
    } catch (error) {
      this.options.log.warn(
        { err: error, sessionId: session.id },
        'Jev: the fast path failed — the model has the sentence',
      );
      return undefined;
    }
  }

  private async fastPath(
    session: ChatSession<AssistantTurn>,
    text: string,
    origin: TurnOrigin | undefined,
  ): Promise<{ origin?: TurnOrigin; turn?: AssistantTurn } | undefined> {
    // A speculation still out on this conversation is worth a short wait: it
    // holds the open connection, and it may have read exactly this sentence.
    const pending = this.pendingSpeculation.get(session.id);
    if (pending !== undefined) await Promise.race([pending, delay(SPECULATION_WAIT_MS)]);

    const reused = this.reuseSpeculation(session.id, text);
    const decision =
      reused ??
      (await decideHomeCommand({
        decider: this.decider,
        home: this.decidableHome(),
        delegates: this.delegates,
        said: text,
      }));
    // Paid for whatever it concluded, including nothing. Banked on this turn's
    // own row rather than on a row of its own — see `decisionUsd`. A reused
    // reading was paid for when it was made (`warmForSpeech`), and counting
    // it again here charged the home twice for one request.
    if (reused === undefined) session.decisionUsd += decision.costUsd;

    /**
     * How hard this round should work, if the reading had a view.
     *
     * **Never on a spoken turn.** `spokenOrigin` already pins those to `low`
     * on product grounds that have nothing to do with the sentence, and
     * letting a reading re-open that would be relitigating a decision this
     * file has already argued at length.
     */
    const via = origin?.via ?? 'typed';
    const eased: TurnOrigin | undefined =
      decision.effort === 'low' && via !== 'voice' ? { effort: 'low', via } : undefined;
    const carry = (result: { turn?: AssistantTurn } | undefined) =>
      eased === undefined ? result : { ...result, origin: eased };
    /**
     * A round whose only job is to say what was done: the lowest effort,
     * whatever this turn was otherwise going to run at. The work is finished;
     * what is left is a sentence.
     */
    const confirming: { origin: TurnOrigin } = { origin: { effort: 'low', via } };

    switch (decision.kind) {
      case 'none':
        this.reportStandDown(session, decision.standDown, via, reused !== undefined);
        return carry(undefined);

      case 'route': {
        // **Typed only.** `spoken()` drops a `handoff` row — the handoff arm
        // writes its own `agent` row saying what was handed over — so skipping
        // the round out loud would leave `askAloud` with nothing to say and
        // the voice would announce that it could not work it out, over a job
        // handed over correctly.
        if (via === 'voice') return carry(undefined);
        if (session.conversation.awaitingAnswer()) return carry(undefined);
        const handed = await this.routeAhead(session, decision.agentKey, text, decision);
        return handed === undefined ? carry(undefined) : { turn: handed };
      }

      case 'act':
        return this.actOn(session, decision.plan, decision.complete, {
          reading: decision,
          via,
          reused: reused !== undefined,
          carry,
          confirming,
        });

      case 'split':
        return this.splitAhead(session, text, decision, {
          via,
          reused: reused !== undefined,
          carry,
          confirming,
        });
    }
  }

  /**
   * Carry out one reading's plan, say so, and tell the round that follows.
   *
   * **The round is only a confirmation when the plan was everything.** A
   * sentence read surely as one request, with nothing it might also have
   * meant left alone, ends in the lowest-effort round, whose only job is to
   * say it was done. Anything less — a question beside the command, a device
   * the reading was not sure about — and the round is the one this turn would
   * have run anyway, told exactly what was done, so it does the rest and
   * nothing twice.
   */
  private async actOn(
    session: ChatSession<AssistantTurn>,
    plan: CommandPlan,
    complete: boolean,
    how: {
      reading: { durationMs: number; newConnection?: boolean | undefined };
      via: ChatVia;
      reused: boolean;
      carry: (result: { turn?: AssistantTurn } | undefined) => BeforeRound;
      confirming: { origin: TurnOrigin };
    },
  ): Promise<BeforeRound> {
    const outcomes = await this.carryOut(session, plan.actions, how.via);
    this.reportActed(session, plan, outcomes, {
      durationMs: how.reading.durationMs,
      newConnection: how.reading.newConnection,
      via: how.via,
      reused: how.reused,
    });
    await this.prime(
      session,
      [{ outcomes, offline: plan.offline }],
      { left: [], complete, doubt: plan.doubt, spared: plan.spared },
      how.via,
    );
    return complete ? how.confirming : how.carry(undefined);
  }

  /**
   * Several different things in one sentence: split it, read the parts, carry
   * out what is sure, and leave the rest to the model.
   *
   * The split is writing, so it is the conversation's own model that does it
   * (`decide/split.ts`) — the model and key the home chose, at the lowest
   * effort, told the home's device names that are several words long so a
   * device called *Light TV* is never cut in two. The parts then go back to Jev
   * in **one** request, every part read in parallel against the devices the
   * sentence mentions at all. Nothing here is worse than not splitting: a
   * split that fails sends the sentence to the model whole, and a part Jev is
   * unsure of is simply left for it, quoted, beside the rest of the sentence.
   */
  private async splitAhead(
    session: ChatSession<AssistantTurn>,
    text: string,
    decision: Extract<HomeDecision, { kind: 'split' }>,
    how: {
      via: ChatVia;
      reused: boolean;
      carry: (result: { turn?: AssistantTurn } | undefined) => BeforeRound;
      confirming: { origin: TurnOrigin };
    },
  ): Promise<BeforeRound> {
    const { via, carry, confirming } = how;
    const split = await this.splitSentence(session, text, decision.deviceNames);
    if (split === null) {
      this.reportStandDown(
        session,
        { question: 'split', reason: 'missed', because: 'the model did not split it' },
        via,
        false,
      );
      return carry(undefined);
    }
    session.decisionUsd += split.costUsd;
    /**
     * **One part is one request after all** — the conversation's model, told
     * the home's device names, read it as one thing where Jev heard several —
     * so the reading of the whole sentence Jev already made is the one that
     * counts, and acting on it costs nothing more. Asking Jev about the single
     * part would only put the same question to it a second time.
     */
    if (split.parts.length < 2) {
      this.options.log.info(
        { sessionId: session.id, splitMs: split.durationMs },
        'Jev: the split came back as one request — reading the sentence whole',
      );
      if (decision.whole.kind === 'none') {
        this.reportStandDown(session, decision.whole.standDown, via, how.reused);
        return carry(undefined);
      }
      return this.actOn(session, decision.whole.plan, leftNothing(decision.whole.plan), {
        reading: decision,
        ...how,
      });
    }
    this.note(session, {
      text: `Jev heard ${split.parts.length} requests`,
      kind: 'routing',
      detail: [...split.parts.map((part) => `“${part}”`), `split in ${Math.round(split.durationMs)} ms`].join(
        ' · ',
      ),
    });

    const read = await decideParts({
      decider: this.decider,
      home: this.decidableHome(),
      parts: split.parts,
      candidates: decision.candidates,
    });
    session.decisionUsd += read.costUsd;

    const done: { outcomes: ActionOutcome[]; offline: CommandPlan['offline'] }[] = [];
    const left: string[] = [];
    const doubt: string[] = [];
    const spared: string[] = [];
    // In the order they were said: "turn the light on and then dim it" is a
    // sequence, and the second part may well be about the first.
    for (const part of read.parts) {
      if (part.reading.kind === 'act') {
        const outcomes = await this.carryOut(session, part.reading.plan.actions, via);
        this.reportActed(session, part.reading.plan, outcomes, {
          durationMs: read.durationMs,
          newConnection: read.newConnection,
          via,
          reused: false,
        });
        done.push({ outcomes, offline: part.reading.plan.offline });
        doubt.push(...part.reading.plan.doubt.filter((name) => !doubt.includes(name)));
        spared.push(...part.reading.plan.spared.filter((name) => !spared.includes(name)));
      } else {
        left.push(part.text);
        this.reportStandDown(session, part.reading.standDown, via, false);
      }
    }
    // Nothing carried out: the round is the ordinary one, over the whole
    // sentence, exactly as if none of this had happened.
    if (done.length === 0) return carry(undefined);
    const complete = left.length === 0 && doubt.length === 0 && spared.length === 0;
    await this.prime(session, done, { left, complete, doubt, spared }, via);
    return complete ? confirming : carry(undefined);
  }

  /**
   * Split a sentence with the conversation's own model and key, or say it
   * could not be — null means "read it whole".
   */
  private async splitSentence(
    session: ChatSession<AssistantTurn>,
    text: string,
    deviceNames: readonly string[],
  ): Promise<SplitResult | null> {
    const provider = session.conversation.provider;
    if (provider !== 'anthropic' && provider !== 'openai') return null;
    const secret = await this.options.settings.aiKey(provider);
    if (secret === null || secret === '') return null;
    const run = this.options.splitRequest ?? (await import('./decide/split.js')).splitRequest;
    return run({
      provider,
      modelId: session.conversation.modelId,
      secret,
      said: text,
      deviceNames,
      log: this.options.log,
    });
  }

  /**
   * Carry out a reading's commands, device by device, and say what each did.
   *
   * **Through `control`, every one** — the path the model's own tool takes,
   * with its activity row named for the person and its once-per-turn record —
   * so the model calling the tool anyway afterwards is a no-op rather than a
   * lamp that flickers. A device's own commands run in order (on, then 40%);
   * devices run a few at a time (`FAST_PATH_CONCURRENCY`). A device that
   * refuses is written down with the adapter's own words and the rest carry
   * on: one unreachable bulb is not a reason to leave the other lights on.
   */
  private async carryOut(
    session: ChatSession<AssistantTurn>,
    actions: readonly DeviceAction[],
    via: ChatVia,
  ): Promise<ActionOutcome[]> {
    const outcomes: ActionOutcome[] = new Array<ActionOutcome>(actions.length);
    let next = 0;
    const work = async (): Promise<void> => {
      while (next < actions.length) {
        const index = next;
        next += 1;
        const action = actions[index]!;
        try {
          for (const { endpointId, command } of action.commands) {
            await this.control(
              session.memberId,
              session.id,
              action.deviceId,
              endpointId,
              command,
              via === 'voice' ? 'voice' : 'assistant',
            );
          }
          outcomes[index] = { action };
        } catch (error) {
          this.options.log.warn(
            { err: error, deviceId: action.deviceId },
            'fast path could not work the device',
          );
          const said = error instanceof Error ? error.message : String(error);
          outcomes[index] = { action, error: said.length > 200 ? `${said.slice(0, 199)}…` : said };
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(FAST_PATH_CONCURRENCY, actions.length) }, () => work()),
    );
    return outcomes;
  }

  /**
   * Say what the fast path did — a step in the trail, and a line in the log.
   *
   * The step is the one a person reads while the reply is still being
   * written: what was done and to what, named — "Jev switched off 4 lights in
   * the Kitchen" — with how long the reading took and how sure it was
   * underneath. The log line is `Jev carried out — …`, so `grep Jev` over the
   * hub's journal shows the turns it acted on beside the ones it stood down on.
   */
  private reportActed(
    session: ChatSession<AssistantTurn>,
    plan: CommandPlan,
    outcomes: readonly ActionOutcome[],
    reading: { durationMs: number; newConnection?: boolean | undefined; via: ChatVia; reused: boolean },
  ): void {
    const failed = outcomes.filter((outcome) => outcome.error !== undefined);
    const words = phrase(plan.wordings, plan.target, plan.plural);
    const took = `${Math.round(reading.durationMs)} ms${reading.newConnection === true ? ', new connection' : ''}`;
    const detail = [
      reading.reused ? 'read while it was being said' : took,
      `confidence ${plan.confidence.toFixed(2)}`,
      failed.length === 0
        ? undefined
        : failed.length === outcomes.length
          ? `failed: ${failed[0]!.error}`
          : `${failed.length} of ${outcomes.length} failed`,
      plan.offline.length === 0
        ? undefined
        : plan.offline.length === 1
          ? `${plan.offline[0]!.deviceName} is offline and was not tried`
          : `${plan.offline.length} offline and not tried`,
      // What it was not sure they meant as well, and left for the model to judge.
      plan.doubt.length === 0 ? undefined : `left ${plan.doubt.join(', ')} to the model`,
      // What "everything" stepped around — the model is told, and reads the sentence.
      plan.spared.length === 0
        ? undefined
        : `left ${plan.spared.join(', ')} as ${plan.spared.length === 1 ? 'it was' : 'they were'}`,
    ]
      .filter((part): part is string => part !== undefined)
      .join(' · ');
    this.note(session, {
      text: failed.length === outcomes.length ? `Jev couldn't get ${plan.target} to do it` : `Jev ${words}`,
      kind: 'routing',
      detail,
    });
    this.options.log.info(
      {
        jev: {
          devices: outcomes.map((outcome) => ({
            device: outcome.action.deviceName,
            commands: outcome.action.commands.map((entry) => entry.command.type),
            ...(outcome.error !== undefined ? { error: outcome.error } : {}),
          })),
          ...(plan.offline.length > 0 ? { offline: plan.offline.map((entry) => entry.deviceName) } : {}),
          ...(plan.doubt.length > 0 ? { doubt: plan.doubt } : {}),
          ...(plan.spared.length > 0 ? { spared: plan.spared } : {}),
          confidence: plan.confidence,
          durationMs: reading.durationMs,
          ...(reading.newConnection !== undefined ? { newConnection: reading.newConnection } : {}),
        },
        sessionId: session.id,
        via: reading.via,
        ...(reading.reused ? { reused: true } : {}),
      },
      `Jev carried out — ${words}${failed.length > 0 ? ` (${failed.length} failed)` : ''}`,
    );
  }

  /**
   * Tell the round that follows what was already done, and what is left.
   *
   * **Priming rather than a message.** It reaches the model and is never
   * written down, so the transcript row stays what the person actually said —
   * `rememberSaved`'s channel, for its reason. `fastPathPriming` is where the
   * wording lives, with the other prompts.
   */
  private async prime(
    session: ChatSession<AssistantTurn>,
    plans: readonly { outcomes: readonly ActionOutcome[]; offline: CommandPlan['offline'] }[],
    rest: {
      /** Parts of a split sentence that were not carried out, as the split wrote them. */
      left: readonly string[];
      /** Whether that was surely everything the message asked for. */
      complete: boolean;
      /** Devices the reading was not sure they meant as well, and left alone. */
      doubt: readonly string[];
      /** Devices "everything" deliberately stepped around. */
      spared: readonly string[];
    },
    via: ChatVia,
  ): Promise<void> {
    // Loaded on demand, like `open()`'s call to the same module: this file's
    // rule is that a prompt is not part of its graph.
    const { fastPathPriming } = await import('./assistant-prompts.js');
    const line = fastPathPriming({
      done: plans.flatMap((plan) => [
        ...plan.outcomes.map((outcome) => ({
          device: outcome.action.deviceName,
          room: outcome.action.roomName,
          did: participle(outcome.action.wordings),
          error: outcome.error,
        })),
        ...plan.offline.map((entry) => ({
          device: entry.deviceName,
          room: entry.roomName,
          did: participle(entry.wordings),
          offline: true,
        })),
      ]),
      left: rest.left,
      complete: rest.complete,
      doubt: rest.doubt,
      spared: rest.spared,
      spoken: via === 'voice',
    });
    session.priming = session.priming === undefined ? line : `${session.priming}\n\n${line}`;
  }

  /**
   * Say why the fast path did not act — in the log on every turn, and in the
   * trail when somebody could have expected it to.
   *
   * **A stand-down used to leave no trace**, which is what made "why was that
   * not instant?" unanswerable: the round that followed was exactly the one a
   * hub with no key runs, so four seconds for a light looked the same whether
   * Jev was switched off, timed out, or was 0.41 sure between two lamps with
   * one name. The line says which question settled it, what it answered and
   * the number against its bar; `describeStandDown` decides who hears it.
   *
   * **A step, never a sentence in the reply.** It is `kind: 'deferred'`, drawn
   * beside `routing`'s bolt as the same act not taken, and it goes on the
   * round's working through `note` like every other line the hub writes before
   * the model is asked. The model is not told: what it would do with the fact
   * is apologise for it, and the reply is the model's to write.
   */
  private reportStandDown(
    session: ChatSession<AssistantTurn>,
    standDown: StandDown,
    via: string,
    reused: boolean,
  ): void {
    const words = describeStandDown(standDown);
    const context = {
      jev: standDown,
      sessionId: session.id,
      via,
      // A reading made while the sentence was still being said, and kept for
      // this turn — so its timing is the speculation's, not this round's.
      ...(reused ? { reused } : {}),
    };
    const line = `Jev stood down — ${words.phrase}${words.detail !== undefined ? ` (${words.detail})` : ''}`;
    if (words.audience === 'quiet') {
      this.options.log.debug(context, line);
      return;
    }
    this.options.log.info(context, line);
    if (words.audience !== 'shown') return;
    this.note(session, {
      text: words.text,
      kind: 'deferred',
      ...(words.detail !== undefined ? { detail: words.detail } : {}),
    });
  }

  /**
   * Hand the job over without spending a round working out that it should be
   * handed over.
   *
   * Through `delegate`, never `agent.start()` — that is what keeps the
   * permission check, the refusal sentence a guest gets, and the resume that
   * makes "now make it half past instead" reach the conversation that wrote
   * the rule.
   *
   * **No prose row.** The turn carries the card and an empty string:
   * `recordAgentTurn` already guards on non-empty text, and a hub-written "I
   * have passed that on" is the one thing this file is careful never to do.
   */
  private async routeAhead(
    session: ChatSession<AssistantTurn>,
    agentKey: string,
    brief: string,
    read: { confidence: number; durationMs: number },
  ): Promise<AssistantTurn | undefined> {
    // The answer space is the registry's own keys, so an unknown one means the
    // table moved under a reading — fall through rather than guess.
    const agent = this.delegates.find((entry) => entry.key === agentKey);
    if (agent === undefined) return undefined;
    this.note(session, {
      text: `Jev passed this to the ${agent.title}`,
      kind: 'routing',
      detail: `${Math.round(read.durationMs)} ms · confidence ${read.confidence.toFixed(2)}`,
    });
    const outcome = await this.delegate({
      memberId: session.memberId,
      sessionId: session.id,
      agentKey: agent.key,
      brief,
    });
    // A refusal is a sentence the *model* should read out and act on, so it
    // goes back to the ordinary round rather than being written here.
    if (outcome.refused !== undefined) return undefined;
    return {
      kind: 'handed',
      handoffs: [{ agent: agent.key, brief, sessionId: outcome.sessionId }],
      text: '',
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
    sessionId: string,
    deviceId: string,
    endpointId: number,
    command: HubCommand,
    via: 'assistant' | 'voice',
  ): Promise<void> {
    /**
     * **Once per turn per command, and the record is what enforces it.**
     *
     * The fast path carries a command out and then tells the model it is
     * done. That is a prompt, and a prompt is a request — a model that calls
     * the tool anyway would switch the lamp twice, which reads as the hub
     * stuttering rather than as anything anyone could report. So the pair is
     * remembered for the length of the turn and the second one is dropped.
     * Narrow on purpose: the *same* command on the same endpoint. Asking for
     * the light on and then off in one turn is a person changing their mind,
     * and both should happen.
     */
    const signature = `${deviceId}:${endpointId}:${JSON.stringify(command)}`;
    const acted = this.actedThisTurn.get(sessionId);
    if (acted?.has(signature) === true) return;
    acted?.add(signature);
    try {
      await this.options.registry.execute(deviceId, endpointId, command);
    } catch (error) {
      // **Only what happened is remembered.** A command the device refused
      // was never carried out, so asking for it again is a real second try —
      // and a model that does gets the adapter's own answer rather than a
      // silent success over a lamp that is still on.
      acted?.delete(signature);
      throw error;
    }
    const device = this.options.engine.homeView().devices.find((entry) => entry.id === deviceId);
    /**
     * **Written down, but never at the price of the answer.** The device has
     * taken the command by now; a row that could not be written — a busy
     * card, a device removed a moment ago — is bookkeeping, and letting it
     * throw told the model, and so the person, that a lamp which had just
     * gone off had not. `ChatRuntime.bank`'s rule, one table over.
     */
    try {
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
          via,
        },
      });
    } catch (error) {
      this.options.log.warn(
        { err: error, deviceId },
        'a command the assistant carried out could not be written to the activity log',
      );
    }
  }

  /** The member's own name, for anything written in the home's voice. */
  /**
   * Who is being talked to, for a prompt that greets them by name.
   *
   * Public because the voice needs it and has no conversation to ask through —
   * its instructions are built once, before a word is said, by the route that
   * mints the session.
   */
  async personName(memberId: string): Promise<string | undefined> {
    return this.memberName(memberId);
  }

  private async memberName(memberId: string): Promise<string | undefined> {
    const row = await this.options.db.query.members.findFirst({ where: eq(members.id, memberId) });
    return row?.name;
  }
}
