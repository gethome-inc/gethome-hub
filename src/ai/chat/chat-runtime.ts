import { randomUUID } from 'node:crypto';
import { and, asc, count, eq, isNull, lt, max, min, or, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { automationChatMessages } from '../../db/schema.js';
import type { AutomationChatEvent, HubEventBus } from '../../core/bus.js';
import type { SettingsService } from '../../core/settings.js';
import type { AiRunKind, AiRunLog, SessionSpend } from '../../core/ai-runs.js';
import type { Logger } from '../../logging.js';
import { modelLabel } from '../models.js';
import { AiUnavailableError } from '../errors.js';
import type { AskUser } from '../automation-tools.js';

/**
 * Everything a conversation with an agent needs that is not about *which*
 * agent — extracted, rather than copied, before there was a second one.
 *
 * `AutomationChat` was already this: sessions with a lifetime, a memory
 * rebuilt from its own transcript, per-round step capture, four socket phases,
 * spend recorded as deltas into `ai_runs`, a fortnight's retention, and the
 * list that makes a conversation findable again. None of that is about
 * writing automations. Copying it for the assistant would have been the fifth
 * time this repository learned that a copied thing is a bug copied twice — and
 * the copies here would have been a thousand lines apart, which is exactly how
 * far apart two answers to one question drift before anybody notices.
 *
 * What a subclass supplies is small and is genuinely its own: which model and
 * prompt open a conversation, and what to write down for the turn arms only it
 * can produce (a rule for the automations agent, a handoff for the assistant).
 *
 * The three arms every agent has — it said something, it asked something, it
 * ran out — are handled here, so a new agent cannot get them subtly different.
 */

/** Which agent's conversation a stored row belongs to. */
export type AgentSurface = 'automation' | 'assistant';

/** How long an idle conversation is kept before its history is dropped. */
export const CHAT_SESSION_TTL_MS = 2 * 60 * 60_000;
/** Conversations held at once, hub-wide, across every surface. */
export const CHAT_MAX_SESSIONS = 8;
/** How long a stored transcript is kept. A chat is read while it is happening
 *  and, occasionally, the next day. */
export const RETAIN_TRANSCRIPT_DAYS = 14;
/** How much of a reopened conversation is read back to the model. The tail,
 *  because what was being discussed when it stopped is what it is about. */
const RECAP_MAX_ROWS = 40;

/**
 * How much of a round's working is kept, and it is a *bound* rather than a
 * capacity.
 *
 * A transcript row is a few hundred bytes by design — that is what makes
 * keeping a fortnight of them affordable on an SD card — and steps are the one
 * thing here that could quietly turn one into kilobytes. Twelve covers every
 * round either agent actually runs; a round that did more than twelve things
 * went wrong in a way these twelve show.
 *
 * The **last** twelve, which is the direction an app's live trail drops from
 * too — so what somebody watched is a suffix of what they read back rather
 * than a different set.
 */
const TURN_STEP_LIMIT = 12;
/** A sentence, and a short paragraph. Cut rather than dropped: a step whose
 *  detail ran long still says what it was. */
const STEP_TEXT_LIMIT = 200;
const STEP_DETAIL_LIMIT = 400;

/**
 * Cut to a bound, at a word, with something saying it was cut.
 *
 * `slice` was enough while these were the hub's own fixed sentences, which
 * never came near either limit. They are not any more: a step's detail now
 * carries the model's reasoning and a `said` step carries its narration, both
 * of them prose written to no length at all — so the cut lands mid-word most
 * times it happens, and reads as a bug rather than as a bound. The ellipsis is
 * the half that matters: without it there is nothing to say the sentence had
 * more in it.
 */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  // The ellipsis counts against the bound, or a "cut to 200" is 201 — which is
  // exactly the kind of off-by-one a bound written down in two repositories
  // gets wrong once and then disagrees about for ever.
  const head = text.slice(0, limit - 1);
  const space = head.lastIndexOf(' ');
  // A limit with no space anywhere near it is one long token; cutting that
  // anywhere is as good as anywhere else.
  return `${(space > limit / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

/**
 * One thing an agent did, kept with the message it produced.
 *
 * **The same three fields the socket frame already carries.** An app draws the
 * live trail from those frames and the stored one from these, so a round read
 * back a week later looks like the round somebody watched — one shape rather
 * than two that would drift.
 *
 * Which is why two things a round produced are now written down that used to
 * be streamed and dropped: the model's **reasoning**, onto the `detail` of the
 * step it was produced under, and prose from a round that then called a tool,
 * as a step of its own (`kind: 'said'`). Both were on screen for the length of
 * the wait and in the record for none of it, so the trail somebody read back
 * was a different, thinner thing than the one they watched.
 *
 * `kind` stays an **open** string, the `commandFailed.kind` rule: a word a
 * later build adds draws the neutral mark and keeps its sentence.
 */
export interface ChatStepWire {
  /**
   * The hub's own sentence, present tense, written for a person — or, on a
   * `said` step, the model's own narration verbatim.
   */
  text: string;
  /**
   * `reading` · `checking` · `writing` · `asking` · `thinking`, and open.
   *
   * **`said` is the one that is never sent as a frame.** It marks prose from a
   * round that then went on to call a tool: the words reached the app as
   * deltas while they were being written, and this is the copy that outlives
   * the round.
   */
  kind: string;
  /**
   * What exactly — the question about to be asked, why a rule came back, or,
   * where the tool sent nothing of its own, the model's reasoning under the
   * step it was produced beneath.
   */
  detail?: string;
}

export interface ChatMessageWire {
  id: string;
  at: string;
  role: 'user' | 'agent' | 'question' | 'preview' | 'handoff' | 'note';
  text: string;
  data?: unknown;
}

/**
 * What a request to say something gets back — **an acknowledgement, not an
 * outcome.**
 *
 * `messages` is what exists the moment the hub takes the message, which is the
 * person's own row and nothing else. Everything the agent then does arrives on
 * the socket: its text as it is produced, a line per tool call, and a `turn`
 * frame saying the stored transcript is now what to draw.
 */
export interface ChatReply {
  sessionId: string;
  messages: ChatMessageWire[];
}

/**
 * What a conversation cost and what answered it.
 *
 * **Absent, never zero, when the hub cannot say.** `ai_runs` keeps the last
 * sixty runs of every kind and a transcript lives a fortnight, so a home that
 * has recognised a few devices since can open a readable chat whose spend row
 * has been pruned — and "$0.00" about a conversation that plainly cost
 * something is a claim, where nothing at all is the truth.
 */
export interface ChatSpendWire {
  /** US dollars. An estimate from token usage, as everything here is. */
  usd: number;
  /** anthropic | openai, as it was recorded. */
  provider: string;
  /** The model id as it was recorded — a fact, so it is never re-derived. */
  modelId: string;
  /** What to call that model: the offered list's label while it is still
   *  offered, and the raw id once it is retired. */
  model: string;
}

export interface ChatSummaryWire {
  sessionId: string;
  startedAt: string;
  updatedAt: string;
  messageCount: number;
  /** The first thing the person said — what they will recognise it by. */
  title: string;
  /** Whether it can still be *continued*, as against merely read. */
  live: boolean;
  /** What it cost and what wrote it. Absent when the ledger no longer has it. */
  spend?: ChatSpendWire;
}

/** What a running turn reports as it happens, for the socket. */
export interface ChatTurnContext {
  /** Text as it arrives, so a chat is not minutes of nothing. */
  onDelta?: (text: string) => void;
  /**
   * The model's own summarized reasoning, as it arrives.
   *
   * **This is what fills the longest silence in a round.** A step is reported
   * when something has *happened*, and the first thing that happens in a round
   * is tens of seconds of the model reading the home and deciding — before a
   * tool has been called or a word of the reply written.
   *
   * Only useful because the loops ask for `display: 'summarized'`; with the
   * default the thinking blocks stream empty and this never fires.
   */
  onThinking?: (text: string) => void;
  /** One line per notable thing the turn did. */
  onStep?: (summary: string, kind: string, detail?: string) => void;
  /**
   * What the model said in a round that then went on to call a tool.
   *
   * **Kept, not sent.** It has already gone out word by word over `onDelta`,
   * so an app watching has it and folds it into its own trail; what it cannot
   * do is recover it later, because only the last round's text becomes the
   * transcript row. So this writes it into the round's working and emits no
   * frame — a second frame carrying words already on screen would be drawn
   * twice.
   */
  onSaid?: (text: string) => void;
}

/**
 * One conversation, owned by whichever vendor's loop is running it.
 *
 * `send` and `answer` are two entry points rather than one because the second
 * has to close a tool call the model is waiting on: an answer to `ask_user`
 * goes back as a `tool_result` for that call's id, and a plain user message
 * after a pending tool call is a conversation the API will refuse.
 */
export interface AgentConversation<Turn> {
  send(text: string, context?: ChatTurnContext): Promise<Turn>;
  answer(text: string, context?: ChatTurnContext): Promise<Turn>;
  /** True while an `ask_user` is outstanding. */
  awaitingAnswer(): boolean;
  costUsd(): number;
  /** Which model has been answering, for the run log and for the apps. */
  readonly modelId: string;
  readonly provider: string;
}

/** The three arms every agent has, whatever else it can end a turn with. */
export type CommonTurn =
  | { kind: 'question'; question: AskUser }
  | { kind: 'said'; text: string }
  | { kind: 'stopped'; reason: string };

/**
 * The conversation cannot start, for a reason somebody can fix.
 *
 * Three codes rather than one, because they lead to three different screens:
 * add a key, switch AI back on, add a key *of the other kind*. Each carries a
 * sentence as well, so an app that meets a code a later build added still has
 * something true to show — the `activity.message` rule applied to a refusal.
 *
 * **Everything that can refuse a conversation has to end up here**, on either
 * surface. One of these once threw an `AiUnavailableError` instead, which the
 * route rethrew into a bare 500, and the app drew "The hub answered 500." over
 * a home that was configured perfectly well, just not for this.
 */
export class AgentNotConfiguredError extends Error {
  constructor(
    readonly code: 'ai_not_configured' | 'ai_disabled' | 'automation_needs_anthropic',
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'AutomationNotConfiguredError';
  }
}

export interface ChatRuntimeOptions {
  db: Db;
  settings: SettingsService;
  events: HubEventBus;
  runs: AiRunLog;
  log: Logger;
}

export interface ChatSession<Turn> {
  id: string;
  memberId: string;
  conversation: AgentConversation<Turn>;
  lastAt: number;
  /**
   * When the conversation opened.
   *
   * Separate from `lastAt`, which every message and every finished turn moves
   * — so the ledger's `durationMs` was `now - lastAt` measured moments after
   * the last thing that set it, and a conversation that ran for four minutes
   * was recorded as having taken twelve milliseconds.
   */
  startedAt: number;
  /**
   * The turn currently running, if one is.
   *
   * A conversation is answered **off** the request that asked for it, so this
   * is both the queue that keeps two messages from running at once and the
   * handle `idle()` waits on. It never rejects, and that is `exchange`'s outer
   * catch rather than an assumption: an unhandled rejection here would end the
   * process.
   */
  inFlight: Promise<void>;
  /**
   * How much of this conversation's spend is already in `ai_runs`.
   *
   * **A number rather than a flag.** Recording used to be once-only, and a
   * conversation records *immediately* when it delivers something, so every
   * dollar spent after the first delivery was dropped on the floor. Each
   * `record` writes the delta since the last one.
   */
  recordedUsd: number;
  /** How many artefacts this conversation has delivered — rules, handoffs. */
  produced: number;
  /**
   * What was said before this session existed, for one that was rebuilt from
   * its own transcript — see `revive`.
   *
   * Carried here rather than written into the conversation, because it must
   * reach the *model* and not the transcript: it is a recap of rows that are
   * already in the transcript, and writing it back would put the whole chat
   * into itself as a message. Consumed on the first exchange and cleared.
   */
  priming?: string | undefined;
  /**
   * What the agent has done **this round**, waiting for the row it produced.
   *
   * Reset when a round begins rather than when it ends, so a turn that threw
   * between the two cannot hand its working to the next one's answer.
   */
  steps: ChatStepWire[];
  /** The artefact this conversation is about, for the ledger and for a
   *  revived conversation's opening context. */
  topic?: string | undefined;
}

/**
 * An aggregate's timestamp, back as ISO.
 *
 * `min()`/`max()` lose the column's `timestamp_ms` mapping on the way out —
 * drizzle only applies it to a plain column read — so what comes back is the
 * stored integer. Every shape SQLite could hand over is accepted rather than
 * one being assumed, because the cost of being wrong here is a date nobody
 * can read on a list somebody opened to find a conversation.
 */
function isoFrom(value: number | string | Date | null): string {
  if (value === null) return new Date(0).toISOString();
  if (value instanceof Date) return value.toISOString();
  const ms = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date(0).toISOString();
}

/**
 * The conversation so far, for a model meeting it again from scratch.
 *
 * Written as a recap rather than replayed as messages: the stored rows are not
 * a provider history — there are no tool calls in them, the assistant's own
 * reasoning is gone, and a `question` row was a tool call rather than prose.
 * One user-turn prefix is the honest shape, and it says plainly that this is a
 * record of what was said rather than something the model remembers, so it
 * does not claim to recall a decision it is only reading.
 */
function recapOf(rows: ChatMessageWire[]): string {
  const lines = rows.slice(-RECAP_MAX_ROWS).map((row) => {
    switch (row.role) {
      case 'user':
        return `They said: ${row.text}`;
      case 'question':
        return `You asked: ${row.text}`;
      case 'preview': {
        // With its id, because `replaces` needs one: a conversation picked up
        // next week is asked to change the rule it wrote, and the only place
        // that id survives is the row that carried the card.
        const id = (row.data as { automationId?: string } | undefined)?.automationId;
        return id === undefined
          ? `You wrote a rule: ${row.text}`
          : `You wrote a rule (id ${id}): ${row.text}`;
      }
      case 'handoff':
        return `You handed a task to another agent: ${row.text}`;
      case 'note':
        return `(the hub noted: ${row.text})`;
      default:
        return `You said: ${row.text}`;
    }
  });

  return [
    'This conversation is being picked up again. You do not remember it — what',
    'follows is the record of what was said, so read it as history rather than',
    'as your own memory, and carry on from the end of it.',
    '',
    ...lines,
    '',
    'That is the whole of it. Their next message follows.',
  ].join('\n');
}

export abstract class ChatRuntime<Turn extends { kind: string }> {
  protected readonly sessions = new Map<string, ChatSession<Turn>>();

  constructor(protected readonly base: ChatRuntimeOptions) {}

  // ── What a surface supplies ────────────────────────────────────────────────

  /** Which agent this is, and so which rows are its own. */
  protected abstract readonly surface: AgentSurface;
  /** The socket event its frames ride on. */
  protected abstract readonly eventName: 'automationChat' | 'assistantChat';
  /** What `ai_runs` files its spend under. */
  protected abstract readonly runKind: AiRunKind;
  /** `ai_runs.adapter`, which is a label rather than a protocol here. */
  protected abstract readonly runAdapter: string;

  /**
   * Build a conversation, refusing before the network is touched.
   *
   * Everything that can refuse is awaited here: a home with no key, or the
   * wrong kind of key, has to be told so as a refusal rather than discovering
   * it through a conversation that never says anything.
   */
  protected abstract openConversation(input: {
    memberId: string;
    topic: string | undefined;
    /**
     * Which conversation this is, for a tool that has to know.
     *
     * The assistant's `delegate` is the one that does: handing a *follow-up*
     * to the agent that already has the job means finding what this
     * conversation handed over before, and a tool context closed over the
     * member alone cannot ask that question. So the id is minted before the
     * conversation rather than after it — the only reason `start` no longer
     * takes `randomUUID()` inline.
     */
    sessionId: string;
  }): Promise<AgentConversation<Turn>>;

  /**
   * Write down a turn arm only this surface can produce.
   *
   * The three shared arms are handled by `recordTurn` above this; anything
   * else is the agent's own and lands here.
   */
  protected abstract recordAgentTurn(
    session: ChatSession<Turn>,
    turn: Turn,
  ): Promise<ChatMessageWire[]>;

  /** What a revived conversation was about, recovered from its own rows.
   *  Most surfaces have nothing to recover and take the default. */
  protected topicFromRows(_rows: ChatMessageWire[]): string | undefined {
    return undefined;
  }

  // ── Starting and continuing ────────────────────────────────────────────────

  /**
   * Start a conversation.
   *
   * The first message carries the home and the request together, so the very
   * first round already knows what it is looking at — a round spent asking
   * "what devices do you have" is a round somebody watched go past.
   */
  async start(input: {
    memberId: string;
    message: string;
    topic?: string | undefined;
  }): Promise<ChatReply> {
    this.sweep();
    if (this.sessions.size >= CHAT_MAX_SESSIONS) {
      // Oldest first: a conversation nobody has touched is the one to lose.
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastAt - b.lastAt)[0];
      if (oldest) await this.close(oldest.id);
    }

    // Minted before the conversation, because a tool context is built with it
    // — see `openConversation`.
    const sessionId = randomUUID();
    const conversation = await this.openConversation({
      memberId: input.memberId,
      topic: input.topic,
      sessionId,
    });
    const session: ChatSession<Turn> = {
      id: sessionId,
      memberId: input.memberId,
      conversation,
      lastAt: Date.now(),
      startedAt: Date.now(),
      inFlight: Promise.resolve(),
      recordedUsd: 0,
      steps: [],
      produced: 0,
      ...(input.topic !== undefined ? { topic: input.topic } : {}),
    };
    this.sessions.set(session.id, session);
    return this.say(session, input.message, 'send');
  }

  /** Continue one. A typed reply to a question is an answer, not a new
   *  message — the conversation itself decides which, since only it knows
   *  whether a tool call is outstanding. */
  async reply(sessionId: string, memberId: string, text: string): Promise<ChatReply | null> {
    const session = this.sessions.get(sessionId) ?? (await this.revive(sessionId, memberId));
    if (!session || session.memberId !== memberId) return null;
    return this.say(session, text, 'auto');
  }

  /**
   * Pick a conversation back up after the hub has forgotten how to continue it.
   *
   * **The two halves of a chat have very different lifetimes, and the shorter
   * one was deciding.** The model's own message history is in memory, dropped
   * after `CHAT_SESSION_TTL_MS` (two hours) or with the process; the transcript
   * keeps for a fortnight. So for thirteen of every fourteen days everything in
   * the conversations list answered `410`, the app drew a closed composer, and
   * "ask it to try again" was not a thing anybody could do.
   *
   * So the memory is rebuilt from the record: same session id, same transcript
   * rows, a fresh provider conversation primed with what was said. What is
   * genuinely lost is the model's *reasoning* and any tool call that was
   * outstanding — a question it had asked is answered as ordinary prose now,
   * which is what a person typing into a reopened chat means anyway.
   *
   * Returns null only for a conversation with no transcript at all, which is
   * one that never existed or whose rows have aged out — a real `410`.
   */
  protected async revive(sessionId: string, memberId: string): Promise<ChatSession<Turn> | null> {
    const rows = await this.transcript(sessionId);
    if (rows.length === 0) return null;

    /**
     * **Whose conversation this is, read back rather than taken on trust.**
     * A live session carries its member and `reply` compares against it; a
     * revived one is built from the caller's own id, so without this any
     * member could reopen anybody's chat by its id and carry it on.
     *
     * A null owner is refused rather than treated as unowned — that column is
     * `ON DELETE SET NULL`, so null means the member who had this conversation
     * has left the home.
     */
    const owner = await this.ownerOf(sessionId);
    if (owner === null || owner !== memberId) return null;

    const topic = this.topicFromRows(rows);
    const conversation = await this.openConversation({ memberId, topic, sessionId });
    const session: ChatSession<Turn> = {
      id: sessionId,
      memberId,
      conversation,
      lastAt: Date.now(),
      startedAt: Date.now(),
      inFlight: Promise.resolve(),
      recordedUsd: 0,
      steps: [],
      produced: 0,
      priming: recapOf(rows),
      ...(topic !== undefined ? { topic } : {}),
    };
    this.sessions.set(sessionId, session);
    this.base.log.info({ sessionId, surface: this.surface }, 'chat: revived from its transcript');
    return session;
  }

  /**
   * Take a message, and answer the moment it is taken.
   *
   * **The `POST /devices/:id/remap` lesson, and this route had the same bug
   * it was written to avoid.** A turn is a loop against a provider — up to a
   * dozen rounds, with a three-minute watchdog — and the request that started
   * it was held open for the whole thing, against a client that gives a hub
   * ten seconds. So a conversation that was working perfectly reported "the
   * request timed out" every time, and the reply it had gone on to produce
   * arrived on a socket nobody was still listening for an answer on.
   *
   * The user's own row is written **synchronously**, so the app draws what was
   * typed the instant it is acknowledged.
   *
   * Turns are **chained per session** rather than run in parallel. A second
   * message while one is running is an ordinary thing for somebody to do, and
   * two exchanges against one provider history at once would interleave the
   * messages array into nonsense. Chaining also means `awaitingAnswer()` is
   * asked when the turn actually begins, not when it was queued.
   */
  protected async say(
    session: ChatSession<Turn>,
    text: string,
    how: 'send' | 'answer' | 'auto',
  ): Promise<ChatReply> {
    const written = await this.write(session, 'user', text, undefined, session.memberId);
    session.lastAt = Date.now();
    session.inFlight = session.inFlight.then(async () => {
      const mode = how === 'auto' ? (session.conversation.awaitingAnswer() ? 'answer' : 'send') : how;
      await this.exchange(session, text, mode);
    });
    return { sessionId: session.id, messages: [written] };
  }

  /**
   * Wait for every conversation to be between turns.
   *
   * For tests, and it is what makes the fire-and-forget above testable at all:
   * a suite that asserted on `start()`'s return value would be asserting on an
   * acknowledgement, which is exactly the thing that used to hide this bug.
   */
  async idle(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.inFlight));
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  /**
   * Rows belonging to this agent.
   *
   * Null is `automation`, because that is what every row written before the
   * column existed is — the migration adds the column and cannot fill it in
   * for a fortnight of history.
   */
  protected get surfaceFilter(): SQL {
    const column = automationChatMessages.surface;
    return this.surface === 'automation'
      ? (or(eq(column, 'automation'), isNull(column)) as SQL)
      : eq(column, this.surface);
  }

  /**
   * Every conversation this home has had with this agent, newest first.
   *
   * **Because a chat you cannot go back to is a chat you have lost.** The
   * transcript outlives the conversation by fourteen days — that split is the
   * whole reason keeping one is affordable — and without a list of them the
   * only way back was a session id nobody has written down.
   *
   * `title` is the **first thing the person said**, which is what they will
   * recognise it by; the agent's own opening line is about the home rather
   * than about what was asked. `live` is whether it can still be *continued*,
   * and is deliberately separate from being readable.
   */
  async list(): Promise<ChatSummaryWire[]> {
    // **Counted in SQLite, and the model's prose never leaves it.** Reading
    // the whole table — fourteen days of every conversation, `text` and all —
    // to derive a count and one title was the wrong shape on a board this
    // size. The aggregate carries no text at all; the titles come from the
    // person's own messages, which are the short ones.
    const totals = await this.base.db
      .select({
        sessionId: automationChatMessages.sessionId,
        startedAt: min(automationChatMessages.at),
        updatedAt: max(automationChatMessages.at),
        messageCount: count(),
      })
      .from(automationChatMessages)
      .where(this.surfaceFilter)
      .groupBy(automationChatMessages.sessionId);

    const said = await this.base.db
      .select({
        sessionId: automationChatMessages.sessionId,
        text: automationChatMessages.text,
      })
      .from(automationChatMessages)
      .where(and(this.surfaceFilter, eq(automationChatMessages.role, 'user')))
      .orderBy(asc(automationChatMessages.at));

    const titles = new Map<string, string>();
    for (const row of said) {
      if (!titles.has(row.sessionId)) titles.set(row.sessionId, row.text);
    }

    const ledger = await this.base.runs.spendBySession();

    return totals
      .map((session) => {
        const spend = this.spendOf(session.sessionId, ledger);
        return {
          sessionId: session.sessionId,
          startedAt: isoFrom(session.startedAt),
          updatedAt: isoFrom(session.updatedAt),
          messageCount: session.messageCount,
          // A conversation with no message from the person at all still gets a
          // title rather than an empty one: the transcript is written row by
          // row and a crash between two of them is possible.
          title: (titles.get(session.sessionId) ?? '').slice(0, 120) || 'Untitled conversation',
          live: this.sessions.has(session.sessionId),
          ...(spend !== undefined ? { spend } : {}),
        };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** What one conversation cost, ledger plus whatever a live one has spent
   *  since its last row. */
  async spend(sessionId: string): Promise<ChatSpendWire | undefined> {
    return this.spendOf(sessionId, await this.base.runs.spendBySession());
  }

  /**
   * The ledger's total for a conversation, plus what a live one has run up
   * since its last row.
   *
   * **A conversation in progress has spent money the ledger has not heard
   * about.** Rows are written when something is delivered and again when the
   * session closes, so a chat somebody is in the middle of — which is exactly
   * the one on screen — would otherwise read as costing nothing while it ran,
   * and jump to its real figure minutes after they had stopped looking.
   *
   * A live session also names its *own* model rather than the last recorded
   * one: it is the more current answer to the same question, and a revived
   * conversation can be running on a model the earlier rows never saw.
   */
  protected spendOf(
    sessionId: string,
    ledger: Map<string, SessionSpend>,
  ): ChatSpendWire | undefined {
    const recorded = ledger.get(sessionId);
    const live = this.sessions.get(sessionId);
    if (live === undefined) {
      if (recorded === undefined) return undefined;
      return {
        usd: recorded.usd,
        provider: recorded.provider,
        modelId: recorded.modelId,
        model: modelLabel(recorded.provider, recorded.modelId),
      };
    }
    // `Math.max` because the two halves are read at different moments: a turn
    // that lands between the ledger read and this one records its delta and
    // moves `recordedUsd` past the total we are subtracting from.
    const pending = Math.max(0, live.conversation.costUsd() - live.recordedUsd);
    return {
      usd: (recorded?.usd ?? 0) + pending,
      provider: live.conversation.provider,
      modelId: live.conversation.modelId,
      model: modelLabel(live.conversation.provider, live.conversation.modelId),
    };
  }

  /** The transcript, oldest first. Readable long after the conversation that
   *  produced it has gone. */
  async transcript(sessionId: string): Promise<ChatMessageWire[]> {
    const rows = await this.base.db
      .select()
      .from(automationChatMessages)
      .where(and(this.surfaceFilter, eq(automationChatMessages.sessionId, sessionId)))
      .orderBy(asc(automationChatMessages.at));
    return rows.map((row) => ({
      id: row.id,
      at: row.at.toISOString(),
      role: row.role as ChatMessageWire['role'],
      text: row.text,
      ...(row.data !== null ? { data: row.data } : {}),
    }));
  }

  /** Who sent the messages in a stored conversation, or null when nobody
   *  still in the home did. */
  protected async ownerOf(sessionId: string): Promise<string | null> {
    const [row] = await this.base.db
      .select({ memberId: automationChatMessages.memberId })
      .from(automationChatMessages)
      .where(and(this.surfaceFilter, eq(automationChatMessages.sessionId, sessionId)))
      .orderBy(asc(automationChatMessages.at))
      .limit(1);
    return row?.memberId ?? null;
  }

  /** Whether this conversation can still be continued, or is history. */
  isLive(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    // Let a turn that is mid-flight finish first: it may still be about to
    // deliver something, and `produced` is what decides whether this
    // conversation goes in the ledger as one that produced anything. It cannot
    // reject — `exchange` wraps every path, the failing ones included.
    await session.inFlight;
    await this.record(session, session.produced > 0);
  }

  // ── One exchange ───────────────────────────────────────────────────────────

  /**
   * One round with the provider, off the request that asked for it.
   *
   * The person's own row is already written — `say` does that synchronously,
   * so the app draws what was typed at once — and everything here reaches the
   * app over the socket instead of being returned.
   */
  protected async exchange(
    session: ChatSession<Turn>,
    text: string,
    how: 'send' | 'answer',
  ): Promise<void> {
    try {
      await this.runExchange(session, text, how);
    } catch (error) {
      /**
       * **The promise `say()` stores must never reject**, and the inner catch
       * below is not enough for that: it covers the provider call and nothing
       * after it, while everything after it touches the disk. A SQLite failure
       * there rejected `inFlight` with no handler attached in that tick, which
       * on Node ≥15 takes the whole hub down; it also made `close()`'s
       * `await session.inFlight` throw, so tidying a conversation away
       * answered 500 and its spend was never written.
       *
       * Nothing here is allowed to be the second failure: the note is
       * attempted and its own refusal swallowed, and `settle` is an event
       * emit, which is what takes the app's spinner down either way.
       */
      this.base.log.error({ err: error }, 'chat turn could not be recorded');
      await this.write(
        session,
        'note',
        'Your hub could not save the rest of that turn. Everything above is still here.',
      ).catch(() => undefined);
      this.settle(session, 'stopped');
    }
  }

  /**
   * One line onto the round's working, bounded.
   *
   * Shared by the two things that record — a step the agent took, and prose it
   * said on the way — because the bound is the point: a transcript row is a
   * few hundred bytes by design, and a recorder that forgot to drop from the
   * front is how one quietly becomes kilobytes. The **front** is what goes,
   * so what an app keeps live is a suffix of what it reads back rather than a
   * different set.
   */
  private keep(session: ChatSession<Turn>, step: ChatStepWire): void {
    session.steps.push(step);
    if (session.steps.length > TURN_STEP_LIMIT) session.steps.shift();
  }

  private async runExchange(
    session: ChatSession<Turn>,
    text: string,
    how: 'send' | 'answer',
  ): Promise<void> {
    // A round's working belongs to that round. Cleared here rather than after
    // the rows are written, so a turn that throws between the two cannot hand
    // its steps to the next answer.
    session.steps = [];
    let turn: Turn;
    /**
     * The model's reasoning since the last step, waiting for something to
     * belong to.
     *
     * **It arrives between one step and the next, which makes it the working
     * of the step already on screen** — and it was streamed and then dropped,
     * so the only sentence in a round that ever says *why* lasted exactly as
     * long as the wait. Written onto that step's `detail` it survives with the
     * rest of the round's working.
     */
    let reasoning = '';
    /**
     * Hang whatever has been reasoned onto the step it was produced under.
     *
     * **Only into an empty slot.** A tool's own `detail` is the better
     * sentence wherever there is one — the device it looked at, why a draft
     * came back — so it is never overwritten; and the buffer is spent either
     * way, because reasoning that belonged to a step which already had a
     * detail belongs to nothing else either.
     */
    const settleReasoning = (): void => {
      const said = reasoning.trim();
      reasoning = '';
      if (said.length === 0) return;
      const last = session.steps[session.steps.length - 1];
      if (last === undefined || last.detail !== undefined) return;
      last.detail = clip(said, STEP_DETAIL_LIMIT);
    };
    try {
      // **Consumed once, and it goes to the model rather than to the row.**
      // `say` has already written what the person typed; this is the recap of
      // a conversation the model is meeting again (see `revive`), and writing
      // it down would put the whole chat inside itself as a message.
      const primed = session.priming !== undefined ? `${session.priming}\n\n${text}` : text;
      session.priming = undefined;

      turn = await session.conversation[how](primed, {
        onStep: (summary, kind, detail) => {
          // Whatever was reasoned belongs to the step it was reasoned under,
          // which is the one already there rather than this one.
          settleReasoning();
          // Kept as well as sent. The frame fills the wait; the copy is what
          // the row the round is about to write carries, so re-reading the
          // conversation next week shows the working rather than only the
          // answer it produced.
          this.keep(session, {
            text: clip(summary, STEP_TEXT_LIMIT),
            kind,
            ...(detail !== undefined ? { detail: clip(detail, STEP_DETAIL_LIMIT) } : {}),
          });
          this.emit({
            sessionId: session.id,
            phase: 'step',
            at: new Date().toISOString(),
            text: summary,
            kind,
            ...(detail !== undefined ? { detail } : {}),
          });
        },
        // **Kept and not sent** — see `ChatTurnContext.onSaid`. The words have
        // already gone out as deltas; what is missing is a copy that outlives
        // the round, and a frame here would put the same sentence on screen
        // twice.
        onSaid: (text) => {
          settleReasoning();
          this.keep(session, { text: clip(text, STEP_TEXT_LIMIT), kind: 'said' });
        },
        onThinking: (delta) => {
          reasoning += delta;
          this.emit({
            sessionId: session.id,
            phase: 'thinking',
            at: new Date().toISOString(),
            text: delta,
          });
        },
        onDelta: (delta) => {
          // The reply has started, so the thinking that led to it is finished
          // — and this is a round that may end without another step, which
          // would leave the buffer with nowhere to go.
          settleReasoning();
          this.emit({
            sessionId: session.id,
            phase: 'delta',
            at: new Date().toISOString(),
            text: delta,
          });
        },
      });
    } catch (error) {
      /**
       * A provider failure is a *message*, not a 500.
       *
       * `describeRunFailure`'s rule one module over: somebody is sitting in
       * front of this, and an HTTP error code with a JSON body glued to it
       * tells them nothing they can act on. The conversation stays open, so
       * fixing a key and saying "try again" works.
       */
      const message =
        error instanceof AiUnavailableError
          ? error.message
          : `Something went wrong talking to the model: ${(error as Error).message}`;
      this.base.log.warn({ err: error }, 'chat turn failed');
      await this.write(session, 'note', message);
      session.lastAt = Date.now();
      // A round that failed still spent money, so it is written down like
      // any other — see the note beside the call on the ordinary path.
      await this.bank(session, false);
      // **The `turn` frame goes out on this path too.** It is what tells an
      // app the stored transcript is ready to re-read — and what takes its
      // "thinking" indicator down. Returning without one left a failed round
      // showing three animated dots for ever, over a note explaining the
      // failure that nothing had gone back for.
      this.settle(session, 'stopped');
      return;
    }

    session.lastAt = Date.now();
    await this.recordTurn(session, turn);
    await this.bank(session, true);
    this.settle(session, turn.kind);
  }

  /**
   * Write what this turn spent into the ledger, now.
   *
   * **A turn is what spends, so a turn is what gets written down**, and
   * leaving it to anything later cost every price in the apps once. The
   * ledger row used to be written when a conversation *delivered* something —
   * a rule submitted, a job handed over — and otherwise only when the idle
   * sweep dropped the session two hours later. The assistant usually delivers
   * nothing at all: it answers a question, switches a lamp on, and its whole
   * cost sits in `ChatSession.conversation`, which is memory. So a hub restart
   * — an update, a radio switch, a power cut — took every unrecorded penny
   * with it, and every conversation that had been open at the time went from
   * naming its price to naming nothing. Which is exactly what an owner sees
   * after updating their hub: the prices, everywhere, gone.
   *
   * Worse, the sweep is only reached from `start`, so a home that stops
   * beginning new conversations never records the ones it had.
   *
   * `record` is already a **delta** and already no-ops when nothing new has
   * been spent, so calling it every turn is what that design was for: several
   * rows sum to one conversation, and the row for the turn that has just
   * landed is on disk before the reply reaches the phone.
   *
   * **Awaited, and never allowed to throw.** One small insert before the
   * `turn` frame goes out, so an app that re-reads the moment it is told the
   * transcript is ready finds the price of the round it has just watched
   * rather than the one before it; and swallowed, because bookkeeping must
   * not be what ends a turn — the run log's own rule, which is also why
   * `AiRunLog.finish` catches its own write.
   */
  private async bank(session: ChatSession<Turn>, ok: boolean): Promise<void> {
    try {
      await this.record(session, ok);
    } catch {
      // Nothing to do about it here, and nothing worth failing a turn for.
    }
  }

  protected emit(event: AutomationChatEvent): void {
    this.base.events.emit(this.eventName, event);
  }

  /** Say the exchange is over and the stored messages are what to draw. */
  protected settle(session: ChatSession<Turn>, kind: string): void {
    this.emit({
      sessionId: session.id,
      phase: 'turn',
      at: new Date().toISOString(),
      text: kind,
    });
  }

  /** The three arms every agent has; everything else is the surface's own. */
  private async recordTurn(session: ChatSession<Turn>, turn: Turn): Promise<ChatMessageWire[]> {
    switch (turn.kind) {
      case 'said':
        return [await this.write(session, 'agent', (turn as unknown as CommonTurn & { kind: 'said' }).text)];

      case 'question': {
        const question = (turn as unknown as CommonTurn & { kind: 'question' }).question;
        return [
          await this.write(session, 'question', question.question, {
            options: question.options ?? [],
            allowFreeText: question.allowFreeText ?? true,
          }),
        ];
      }

      case 'stopped':
        return [
          await this.write(
            session,
            'note',
            (turn as unknown as CommonTurn & { kind: 'stopped' }).reason,
          ),
        ];

      default:
        return this.recordAgentTurn(session, turn);
    }
  }

  // ── Bookkeeping ────────────────────────────────────────────────────────────

  /**
   * One row of the transcript, and the round's working with the first of them.
   *
   * **The steps go on the first row the round writes, whichever kind it is.**
   * A round can end as prose, as a question, as a line plus a card, or as a
   * note saying the model failed — and the working is worth the same in all
   * four, so the rule is a position rather than a list of cases. It is also
   * what puts them *above* the whole group.
   *
   * A `user` row never takes them: it is written before the round starts, and
   * it is the one row here that is not the agent's answer to anything.
   */
  protected async write(
    session: ChatSession<Turn>,
    role: ChatMessageWire['role'],
    text: string,
    data?: unknown,
    memberId?: string,
  ): Promise<ChatMessageWire> {
    const steps = role === 'user' ? [] : session.steps;
    if (steps.length > 0) session.steps = [];
    const payload =
      steps.length > 0
        ? { ...(typeof data === 'object' && data !== null ? data : {}), steps }
        : data;

    const row = {
      sessionId: session.id,
      role,
      text: text.slice(0, 4_000),
      data: payload ?? null,
      memberId: memberId ?? null,
      surface: this.surface,
    };
    try {
      const [written] = await this.base.db.insert(automationChatMessages).values(row).returning();
      if (written) {
        return {
          id: written.id,
          at: written.at.toISOString(),
          role,
          text: written.text,
          ...(payload !== undefined ? { data: payload } : {}),
        };
      }
    } catch {
      // A transcript is a convenience; losing a line must not end the
      // conversation it describes.
    }
    return {
      id: randomUUID(),
      at: new Date().toISOString(),
      role,
      text: row.text,
      ...(payload !== undefined ? { data: payload } : {}),
    };
  }

  /**
   * Change a row that has already been written.
   *
   * The one thing here that is not append-only, and it exists for exactly one
   * case: a handoff row whose delegated agent has since finished. The
   * alternative — a second row saying "and now it is done" — would put the
   * same card in a transcript twice and leave the first one lying about the
   * present tense for ever.
   */
  protected async amend(messageId: string, data: unknown): Promise<void> {
    await this.base.db
      .update(automationChatMessages)
      .set({ data })
      .where(eq(automationChatMessages.id, messageId))
      .catch(() => undefined);
  }

  /** One `ai_runs` row per delivery, so the home's AI spend stays one list
   *  rather than several screens answering one question. */
  protected async record(session: ChatSession<Turn>, ok: boolean): Promise<void> {
    const spent = session.conversation.costUsd() - session.recordedUsd;
    // Nothing new to say. A conversation is recorded when it delivers and
    // again when it ends, and the second of those is usually zero.
    if (spent <= 0 && session.recordedUsd > 0) return;
    session.recordedUsd = session.conversation.costUsd();

    const handle = this.base.runs.begin({
      kind: this.runKind,
      adapter: this.runAdapter,
      // Empty on purpose: this column is about a device model, and a
      // conversation is not about one.
      exposesHash: '',
      provider: session.conversation.provider,
      modelId: session.conversation.modelId,
      // What the conversation produced, when it produced one. A chat that
      // delivered nothing leaves it null, which is the honest answer.
      ...(session.topic !== undefined ? { automationId: session.topic } : {}),
      // And which conversation it was, which is what makes the spend
      // answerable per chat rather than only per rule.
      sessionId: session.id,
    });
    await handle.finish({
      ok,
      // The delta, not the total: several rows can belong to one conversation
      // — a delivery, the tail after it, and one per revival — and each has to
      // be a real amount or the ledger double-counts when they are summed.
      costUsd: spent,
      durationMs: Date.now() - session.startedAt,
    });
  }

  /** Drop conversations nobody is coming back to, and prune old transcripts. */
  sweep(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastAt < CHAT_SESSION_TTL_MS) continue;
      this.sessions.delete(id);
      void this.record(session, session.produced > 0).catch(() => undefined);
    }
    void this.base.db
      .delete(automationChatMessages)
      .where(
        lt(automationChatMessages.at, new Date(now - RETAIN_TRANSCRIPT_DAYS * 24 * 60 * 60_000)),
      )
      .catch(() => undefined);
  }
}
