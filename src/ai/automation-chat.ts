import { randomUUID } from 'node:crypto';
import { asc, count, eq, lt, max, min } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { automationChatMessages } from '../db/schema.js';
import type { HubEventBus } from '../core/bus.js';
import type { AiProvider, SettingsService } from '../core/settings.js';
import type { AiRunLog } from '../core/ai-runs.js';
import type { Logger } from '../logging.js';
import type { AutomationEngine } from '../automations/engine.js';
import type { AutomationStore } from '../automations/store.js';
import { automationDocumentSchema, type AutomationDocument } from '../automations/schema.js';
import { automationShape, describeAutomation } from '../automations/summarize.js';
import { effectiveModel } from './models.js';
import { AiUnavailableError } from './errors.js';
import {
  AUTOMATION_MAX_SESSIONS,
  AUTOMATION_SESSION_TTL_MS,
  type AutomationConversation,
  type AutomationTurn,
} from './automation-conversation.js';
import type { AskUser } from './automation-tools.js';

/**
 * The conversations in which rules get written.
 *
 * Two stores, deliberately, and the split is what makes keeping a chat at all
 * affordable on an SD card:
 *
 *  - **in memory**, the provider's own message history — thinking blocks, tool
 *    calls, the home inventory, every round of clarification. Tens of
 *    kilobytes per round, needed only to continue the conversation, and it
 *    dies with the process;
 *  - **on disk**, the transcript an app draws. A few hundred bytes a message.
 *
 * So a hub restart costs the *continuation* and not the record: the chat is
 * still readable, continuing means starting a new one, and the rule it
 * produced is a row in `automations` either way. Sessions also expire on their
 * own — a conversation nobody has touched for two hours is one nobody is
 * coming back to, and holding a provider client open for it is memory a Pi
 * needs.
 *
 * **A conversation costs nothing until somebody starts one.** No client, no
 * prompt, no import of the vendor SDK — `resolveProvider` loads whichever half
 * it needs on the first message, which is the `lazy.ts` seam applied one
 * module over.
 */

export interface ChatSession {
  id: string;
  memberId: string;
  /** The rule being edited, when this conversation is an edit. */
  automationId?: string | undefined;
  conversation: AutomationConversation;
  lastAt: number;
  /**
   * When the conversation opened.
   *
   * Separate from `lastAt`, which every message and every finished turn moves
   * — so the ledger's `durationMs` was `now - lastAt` measured moments after
   * the last thing that set it, and a conversation that ran for four minutes
   * was recorded as having taken twelve milliseconds. A swept one was worse:
   * it recorded the two-hour idle TTL.
   */
  startedAt: number;
  /**
   * The turn currently running, if one is.
   *
   * A conversation is answered **off** the request that asked for it (see
   * `exchange`), so this is both the queue that keeps two messages from
   * running at once and the handle `idle()` waits on. It never rejects, and
   * that is `exchange`'s outer catch rather than an assumption: an
   * unhandled rejection here would end the process.
   */
  inFlight: Promise<void>;
  /** Whether this conversation's spend has been written down yet. */
  recorded: boolean;
  submissions: number;
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
}

export interface ChatMessageWire {
  id: string;
  at: string;
  role: 'user' | 'agent' | 'question' | 'preview' | 'note';
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
/** One past conversation, as a list of them is drawn. */
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
 *
 * Bounded: a fortnight of one conversation can be long, and the tail is the
 * part that matters — what was being discussed when it stopped.
 */
function recapOf(rows: ChatMessageWire[]): string {
  const lines = rows.slice(-RECAP_MAX_ROWS).map((row) => {
    switch (row.role) {
      case 'user':
        return `They said: ${row.text}`;
      case 'question':
        return `You asked: ${row.text}`;
      case 'preview':
        return `You wrote a rule: ${row.text}`;
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

export interface ChatSummaryWire {
  sessionId: string;
  startedAt: string;
  updatedAt: string;
  messageCount: number;
  /** The first thing the person said — what they will recognise it by. */
  title: string;
  /** Whether it can still be *continued*, as against merely read. */
  live: boolean;
}

export interface ChatReply {
  sessionId: string;
  /** The message rows this exchange has produced so far — the user's own. */
  messages: ChatMessageWire[];
}

/**
 * The conversation cannot start, for a reason somebody can fix.
 *
 * Three codes rather than one, because they lead to three different screens:
 * add a key, switch AI back on, add a key *of the other kind*. Each carries a
 * sentence as well, so an app that meets a code a later build added still has
 * something true to show — the `activity.message` rule applied to a refusal.
 *
 * **Everything that can refuse a conversation has to end up here.** It used to
 * be only these two, and the third case — a home whose only key is OpenAI's —
 * threw an `AiUnavailableError` instead, which the route rethrew into a bare
 * 500. The app drew "The hub answered 500." over a home that was configured
 * perfectly well, just not for this.
 */
export class AutomationNotConfiguredError extends Error {
  constructor(
    readonly code: 'ai_not_configured' | 'ai_disabled' | 'automation_needs_anthropic',
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'AutomationNotConfiguredError';
  }
}

export interface AutomationChatOptions {
  db: Db;
  settings: SettingsService;
  engine: AutomationEngine;
  store: AutomationStore;
  events: HubEventBus;
  runs: AiRunLog;
  log: Logger;
  /** Overridden in tests, so the suite never reaches a provider. */
  createConversation?: (input: {
    modelId: string;
    secret: string;
    systemPrompt: string;
    taskPrompt: string;
  }) => AutomationConversation;
}

/** How long a stored transcript is kept. A chat is read while it is happening
 *  and, occasionally, the next day. */
const RETAIN_TRANSCRIPT_DAYS = 14;
/** How much of a reopened conversation is read back to the model. The tail,
 *  because what was being discussed when it stopped is what it is about. */
const RECAP_MAX_ROWS = 40;

export class AutomationChat {
  private readonly sessions = new Map<string, ChatSession>();

  constructor(private readonly options: AutomationChatOptions) {}

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
    automationId?: string | undefined;
  }): Promise<ChatReply> {
    this.sweep();
    if (this.sessions.size >= AUTOMATION_MAX_SESSIONS) {
      // Oldest first: a conversation nobody has touched is the one to lose.
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastAt - b.lastAt)[0];
      if (oldest) await this.close(oldest.id);
    }

    // Everything that can refuse is awaited: a home with no key, or the wrong
    // kind of key, has to be told so as a refusal rather than discovering it
    // through a conversation that never says anything. None of it touches the
    // network — a settings read and two prompt strings.
    const conversation = await this.resolveConversation(input.automationId);
    const session: ChatSession = {
      id: randomUUID(),
      memberId: input.memberId,
      conversation,
      lastAt: Date.now(),
      startedAt: Date.now(),
      inFlight: Promise.resolve(),
      recorded: false,
      submissions: 0,
      ...(input.automationId !== undefined ? { automationId: input.automationId } : {}),
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
   * after `AUTOMATION_SESSION_TTL_MS` (two hours) or with the process; the
   * transcript keeps for a fortnight. So for thirteen of every fourteen days
   * everything in the conversations list answered `410`, the app drew a closed
   * composer, and "ask it to try again" was not a thing anybody could do — on
   * a conversation that had worked perfectly as much as on one that had
   * failed. A record you cannot add to is a record, not a conversation.
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
  private async revive(sessionId: string, memberId: string): Promise<ChatSession | null> {
    const rows = await this.transcript(sessionId);
    if (rows.length === 0) return null;

    /**
     * **Whose conversation this is, read back rather than taken on trust.**
     * A live session carries its member and `reply` compares against it; a
     * revived one is built from the caller's own id, so without this any
     * member could reopen anybody's chat by its id and carry it on. The rows
     * remember: `automation_chat_messages.member_id` is written with every
     * message the person sent.
     *
     * A null owner is refused rather than treated as unowned — that column is
     * `ON DELETE SET NULL`, so null means the member who had this conversation
     * has left the home.
     */
    const owner = await this.ownerOf(sessionId);
    if (owner === null || owner !== memberId) return null;

    // The rule it was about, recovered from the transcript rather than
    // remembered: a preview row carries the id, and an edit conversation that
    // produced one is still an edit conversation.
    const automationId = rows
      .map((row) => (row.data as { automationId?: string } | undefined)?.automationId)
      .filter((id): id is string => typeof id === 'string')
      .at(-1);

    const conversation = await this.resolveConversation(automationId);
    const session: ChatSession = {
      id: sessionId,
      memberId,
      conversation,
      lastAt: Date.now(),
      startedAt: Date.now(),
      inFlight: Promise.resolve(),
      recorded: false,
      submissions: 0,
      priming: recapOf(rows),
      ...(automationId !== undefined ? { automationId } : {}),
    };
    this.sessions.set(sessionId, session);
    this.options.log.info({ sessionId }, 'automation chat: revived from its transcript');
    return session;
  }

  /**
   * Take a message, and answer the moment it is taken.
   *
   * **The `POST /devices/:id/remap` lesson, and this route had the same bug
   * it was written to avoid.** A turn is a loop against a provider — up to
   * twelve rounds, with a three-minute watchdog — and the request that started
   * it was held open for the whole thing, against a client that gives a hub
   * ten seconds. So a conversation that was working perfectly reported "the
   * request timed out" every time, and the reply it had gone on to produce
   * arrived on a socket nobody was still listening for an answer on.
   *
   * The user's own row is written **synchronously**, so the app draws what was
   * typed the instant it is acknowledged. Everything the agent does then
   * arrives on the stream, and the `turn` frame is what says the transcript is
   * ready to re-read.
   *
   * Turns are **chained per session** rather than run in parallel. A second
   * message while one is running is an ordinary thing for somebody to do, and
   * two exchanges against one provider history at once would interleave the
   * messages array into nonsense. Chaining also means `awaitingAnswer()` is
   * asked when the turn actually begins, not when it was queued — by which
   * time a question may have opened or closed.
   */
  private async say(
    session: ChatSession,
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
   * The assertion belongs on the stored transcript — what the app actually
   * draws — and this is how a test gets to the point where there is one.
   */
  async idle(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.inFlight));
  }

  /**
   * Every conversation this home has had, newest first.
   *
   * **Because a chat you cannot go back to is a chat you have lost.** The
   * transcript outlives the conversation by fourteen days — that split is the
   * whole reason keeping one is affordable — and without a list of them the
   * only way back was a session id nobody has written down. Closing the page
   * threw the conversation away as surely as if it had never been stored.
   *
   * `title` is the **first thing the person said**, which is what they will
   * recognise it by; the agent's own opening line is about the home rather
   * than about what was asked. `live` is whether it can still be *continued* —
   * the model's message history is in memory and dies with the process — and
   * is deliberately separate from being readable, because they are two
   * different things and an app has to say which one it is offering.
   */
  async list(): Promise<ChatSummaryWire[]> {
    // **Counted in SQLite, and the model's prose never leaves it.** Every
    // screen that draws automations asks for this, so reading the whole table
    // — fourteen days of every conversation, `text` and all, up to 4 000
    // characters a row — to derive a count and one title was the wrong shape
    // on a board this size. The aggregate carries no text at all; the titles
    // come from the person's own messages, which are the short ones and a
    // fraction of the rows.
    const totals = await this.options.db
      .select({
        sessionId: automationChatMessages.sessionId,
        startedAt: min(automationChatMessages.at),
        updatedAt: max(automationChatMessages.at),
        messageCount: count(),
      })
      .from(automationChatMessages)
      .groupBy(automationChatMessages.sessionId);

    const said = await this.options.db
      .select({
        sessionId: automationChatMessages.sessionId,
        text: automationChatMessages.text,
      })
      .from(automationChatMessages)
      .where(eq(automationChatMessages.role, 'user'))
      .orderBy(asc(automationChatMessages.at));

    const titles = new Map<string, string>();
    for (const row of said) {
      if (!titles.has(row.sessionId)) titles.set(row.sessionId, row.text);
    }

    return totals
      .map((session) => ({
        sessionId: session.sessionId,
        startedAt: isoFrom(session.startedAt),
        updatedAt: isoFrom(session.updatedAt),
        messageCount: session.messageCount,
        // A conversation with no message from the person at all still gets a
        // title rather than an empty one: the transcript is written row by
        // row and a crash between two of them is possible.
        title: (titles.get(session.sessionId) ?? '').slice(0, 120) || 'Untitled conversation',
        live: this.sessions.has(session.sessionId),
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** The transcript, oldest first. Readable long after the conversation that
   *  produced it has gone. */
  async transcript(sessionId: string): Promise<ChatMessageWire[]> {
    const rows = await this.options.db
      .select()
      .from(automationChatMessages)
      .where(eq(automationChatMessages.sessionId, sessionId))
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
  private async ownerOf(sessionId: string): Promise<string | null> {
    const [row] = await this.options.db
      .select({ memberId: automationChatMessages.memberId })
      .from(automationChatMessages)
      .where(eq(automationChatMessages.sessionId, sessionId))
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
    // submit a rule, and `submissions` is what decides whether this
    // conversation goes in the ledger as one that produced something. It
    // cannot reject — `exchange` wraps every path, the failing ones included.
    await session.inFlight;
    await this.record(session, session.submissions > 0);
  }

  // ── One exchange ───────────────────────────────────────────────────────────

  /**
   * One round with the provider, off the request that asked for it.
   *
   * The person's own row is already written — `say` does that synchronously,
   * so the app draws what was typed at once — and everything here reaches the
   * app over the socket instead of being returned.
   */
  private async exchange(
    session: ChatSession,
    text: string,
    how: 'send' | 'answer',
  ): Promise<void> {
    try {
      await this.runExchange(session, text, how);
    } catch (error) {
      /**
       * **The promise `say()` stores must never reject**, and the inner catch
       * below is not enough for that: it covers the provider call and nothing
       * after it, while everything after it touches the disk — the transcript
       * row, saving a submitted rule, `engine.reload()`. A SQLite failure
       * there rejected `inFlight` with no handler attached in that tick,
       * which on Node ≥15 takes the whole hub down; it also made `close()`'s
       * `await session.inFlight` throw, so tidying a conversation away
       * answered 500 and its spend was never written.
       *
       * Nothing here is allowed to be the second failure: the note is
       * attempted and its own refusal swallowed, and `settle` is an event
       * emit, which is what takes the app's spinner down either way.
       */
      this.options.log.error({ err: error }, 'automation chat turn could not be recorded');
      await this.write(
        session,
        'note',
        'Your hub could not save the rest of that turn. Everything above is still here.',
      ).catch(() => undefined);
      this.settle(session, 'stopped');
    }
  }

  private async runExchange(
    session: ChatSession,
    text: string,
    how: 'send' | 'answer',
  ): Promise<void> {
    let turn: AutomationTurn;
    try {
      // **Consumed once, and it goes to the model rather than to the row.**
      // `say` has already written what the person typed; this is the recap of
      // a conversation the model is meeting again (see `revive`), and writing
      // it down would put the whole chat inside itself as a message.
      const primed = session.priming !== undefined ? `${session.priming}\n\n${text}` : text;
      session.priming = undefined;

      turn = await session.conversation[how](primed, {
        onStep: (summary, kind, detail) => {
          this.options.events.emit('automationChat', {
            sessionId: session.id,
            phase: 'step',
            at: new Date().toISOString(),
            text: summary,
            kind,
            ...(detail !== undefined ? { detail } : {}),
          });
        },
        onThinking: (delta) => {
          this.options.events.emit('automationChat', {
            sessionId: session.id,
            phase: 'thinking',
            at: new Date().toISOString(),
            text: delta,
          });
        },
        onDelta: (delta) => {
          this.options.events.emit('automationChat', {
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
      this.options.log.warn({ err: error }, 'automation chat turn failed');
      await this.write(session, 'note', message);
      session.lastAt = Date.now();
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
    this.settle(session, turn.kind);
  }

  /** Say the exchange is over and the stored messages are what to draw. */
  private settle(session: ChatSession, kind: string): void {
    this.options.events.emit('automationChat', {
      sessionId: session.id,
      phase: 'turn',
      at: new Date().toISOString(),
      text: kind,
    });
  }

  private async recordTurn(session: ChatSession, turn: AutomationTurn): Promise<ChatMessageWire[]> {
    switch (turn.kind) {
      case 'said':
        return [await this.write(session, 'agent', turn.text)];

      case 'question': {
        const question: AskUser = turn.question;
        return [
          await this.write(session, 'question', question.question, {
            options: question.options ?? [],
            allowFreeText: question.allowFreeText ?? true,
          }),
        ];
      }

      case 'stopped':
        return [await this.write(session, 'note', turn.reason)];

      case 'submitted': {
        const parsed = automationDocumentSchema.safeParse(turn.document);
        if (!parsed.success) {
          // The loop already validated this, so reaching here means the two
          // disagree — worth saying rather than writing a broken preview.
          return [await this.write(session, 'note', 'The rule could not be saved.')];
        }
        const saved = await this.save(session, parsed.data);
        session.submissions += 1;
        // A conversation that produced a rule has done its job; recording the
        // spend now means an abandoned tab does not delay the row for hours.
        await this.record(session, true);
        const messages: ChatMessageWire[] = [];
        if (turn.text.trim().length > 0) {
          messages.push(await this.write(session, 'agent', turn.text));
        }
        /**
         * The card an app draws, and it carries the rule's **name** and its
         * real `enabled` rather than assuming either.
         *
         * The name because the row's `text` is the rule's *summary* — an app
         * that wanted a title would otherwise have to look the id up in a list
         * it may not have refetched yet, and would draw an untitled card for
         * the second it took. And `enabled` read back from the store because
         * an *edit* lands on a rule somebody already chose to have running:
         * hardcoding `false` here said "saved, switched off" about a rule that
         * was, at that moment, switched on.
         */
        const savedRecord = this.options.engine.get(saved);
        messages.push(
          await this.write(session, 'preview', describeAutomation(parsed.data, this.options.engine.homeView()), {
            automationId: saved,
            name: parsed.data.name,
            shape: automationShape(parsed.data),
            enabled: savedRecord?.enabled ?? false,
            edited: session.automationId !== undefined,
          }),
        );
        return messages;
      }
    }
  }

  /**
   * Write the rule down — created **switched off**, or applied as an edit.
   *
   * An edit takes effect on a rule the person already chose to have running,
   * which is why it is versioned: `POST /automations/:id/revert` is the way
   * back, and the version note says the chat did it.
   */
  private async save(session: ChatSession, document: AutomationDocument): Promise<string> {
    if (session.automationId !== undefined && this.options.engine.get(session.automationId)) {
      await this.options.store.update(
        session.automationId,
        document,
        session.memberId,
        'edited in chat',
      );
      await this.options.engine.reload();
      this.options.events.emit('automationChanged', session.automationId);
      return session.automationId;
    }
    const record = await this.options.store.create(document, session.memberId, 'written in chat');
    await this.options.engine.reload();
    this.options.events.emit('automationChanged', record.id);
    // **The conversation is now about this rule**, which is what makes a
    // second submission an *edit* rather than a second rule — the model
    // resubmitting after "make it half past seven instead" would otherwise
    // leave two rules in the home, one of them the draft nobody wanted — and
    // it is what the `ai_runs` row records as what the spend bought.
    session.automationId = record.id;
    return record.id;
  }

  // ── Provider ───────────────────────────────────────────────────────────────

  /**
   * Build the conversation, loading only the half this home is configured for.
   *
   * `ai_enabled` is checked here as well as at the route, for the reason
   * `resolveProvider` checks it: the switch has to be true for a service
   * somebody constructed directly, not only for the one path that happens to
   * ask first.
   */
  private async resolveConversation(automationId: string | undefined): Promise<AutomationConversation> {
    const ai = await this.options.settings.getAiSettings();
    if (!ai.enabled) throw new AutomationNotConfiguredError('ai_disabled');
    if (!ai.hasKey) throw new AutomationNotConfiguredError('ai_not_configured');

    /**
     * **This agent picks its own provider, and it is deliberately not the
     * mapper's.**
     *
     * `ai.provider` answers "which model reads a device's exposes tree" — a
     * real choice, because both halves of *that* are written. Only one half of
     * this one is, so reading the same field turned an unrelated preference
     * into a refusal: a home with both keys that recognises devices with
     * OpenAI could not write a rule at all, with a perfectly good Anthropic
     * key sitting beside it. Worse, the refusal was an `AiUnavailableError`
     * the route rethrew as a 500.
     *
     * So: run on Anthropic whenever the home has a key that can, and refuse
     * only when it genuinely has none. Switching the *mapping* provider must
     * not change whether rules can be written, in either direction.
     *
     * A subscription token is not an API key — the loop authenticates with
     * `x-api-key` — so a home holding only that has, for this purpose, no
     * Anthropic key at all.
     */
    const provider: AiProvider = ai.anthropic.hasKey && !ai.legacySubscriptionToken
      ? 'anthropic'
      : 'openai';
    const secret = await this.options.settings.aiKey(provider);
    if (!secret) throw new AutomationNotConfiguredError('ai_not_configured');

    // `effectiveModel`, never the stored column — the one bug that cost the
    // mapper a release: every surface that *reported* a model went through it
    // while the call that picked one to run read the column.
    const modelId = effectiveModel(provider, ai[provider].model);

    const home = this.options.engine.homeView();
    const editing =
      automationId !== undefined ? this.options.engine.get(automationId) : undefined;

    // Imported here rather than at the top: a home running on one provider
    // never loads the other's client, which for Anthropic means not loading
    // its SDK at all.
    const [{ automationSystemPrompt, automationTaskPrompt }] = await Promise.all([
      import('./automation-prompts.js'),
    ]);
    const systemPrompt = automationSystemPrompt();
    const taskPrompt = automationTaskPrompt({
      home,
      timezone: this.options.settings.timezone,
      ...(editing
        ? { editing: { id: editing.id, name: editing.name, document: editing.document } }
        : {}),
    });

    if (provider !== 'anthropic') {
      // The OpenAI half of this agent is not written yet. It is a *refusal*
      // rather than a failure — the home is configured, just not for this — so
      // it carries a code an app can branch on and a sentence naming the one
      // thing to do about it.
      throw new AutomationNotConfiguredError(
        'automation_needs_anthropic',
        'Writing automations needs an Anthropic key at the moment. Add one in the home’s AI ' +
          'settings; device portraits and recognition carry on using OpenAI.',
      );
    }

    /**
     * The test seam, and it sits **after** every configuration check on
     * purpose.
     *
     * It stands in for the network, not for the rules. Above the checks it was
     * a bypass: a suite could reach a conversation on a home the real hub
     * would have refused, which is the "a mock laxer than the thing it stands
     * in for tests the mock" trap — and it is why the refusal below shipped
     * with no test at all and reached a phone as a 500.
     */
    if (this.options.createConversation) {
      return this.options.createConversation({ modelId, secret, systemPrompt, taskPrompt });
    }

    const { createAutomationConversation } = await import('./automation-agent.js');
    return createAutomationConversation({
      auth: { secret },
      modelId,
      systemPrompt,
      taskPrompt,
      log: this.options.log,
      tools: {
        home: () => this.options.engine.homeView(),
        timezone: () => this.options.settings.timezone,
        stateOf: (deviceId, endpointId) => this.options.engine.stateFor(deviceId, endpointId),
      },
    });
  }

  // ── Bookkeeping ────────────────────────────────────────────────────────────

  private async write(
    session: ChatSession,
    role: ChatMessageWire['role'],
    text: string,
    data?: unknown,
    memberId?: string,
  ): Promise<ChatMessageWire> {
    const row = {
      sessionId: session.id,
      role,
      text: text.slice(0, 4_000),
      data: data ?? null,
      memberId: memberId ?? null,
    };
    try {
      const [written] = await this.options.db.insert(automationChatMessages).values(row).returning();
      if (written) {
        return {
          id: written.id,
          at: written.at.toISOString(),
          role,
          text: written.text,
          ...(data !== undefined ? { data } : {}),
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
      ...(data !== undefined ? { data } : {}),
    };
  }

  /** One `ai_runs` row per conversation, so the home's AI spend stays one
   *  list rather than two screens answering one question. */
  private async record(session: ChatSession, ok: boolean): Promise<void> {
    if (session.recorded) return;
    session.recorded = true;
    const handle = this.options.runs.begin({
      kind: 'automate',
      adapter: 'automations',
      // Empty on purpose: this column is about a device model, and a
      // conversation is not about one.
      exposesHash: '',
      provider: session.conversation.provider,
      modelId: session.conversation.modelId,
      // What the conversation produced, when it produced one — the link the
      // column was added for and nothing had ever written. A chat that
      // submitted nothing leaves it null, which is the honest answer.
      ...(session.automationId !== undefined ? { automationId: session.automationId } : {}),
    });
    await handle.finish({
      ok,
      costUsd: session.conversation.costUsd(),
      durationMs: Date.now() - session.startedAt,
    });
  }

  /** Drop conversations nobody is coming back to, and prune old transcripts. */
  sweep(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastAt < AUTOMATION_SESSION_TTL_MS) continue;
      this.sessions.delete(id);
      void this.record(session, session.submissions > 0).catch(() => undefined);
    }
    void this.options.db
      .delete(automationChatMessages)
      .where(
        lt(automationChatMessages.at, new Date(now - RETAIN_TRANSCRIPT_DAYS * 24 * 60 * 60_000)),
      )
      .catch(() => undefined);
  }
}
