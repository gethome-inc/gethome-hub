import { randomUUID } from 'node:crypto';
import { and, asc, count, eq, isNull, lt, max, min, or, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { automationChatMessages } from '../../db/schema.js';
import type { AutomationChatEvent, HubEventBus } from '../../core/bus.js';
import type { SettingsService } from '../../core/settings.js';
import type { AiRunKind, AiRunLog, SessionSpend } from '../../core/ai-runs.js';
import type { Logger } from '../../logging.js';
import {
  AGENT_EFFORT,
  CHAT_EFFORTS,
  modelLabel,
  requestedAgentModel,
  type ChatEffort,
} from '../models.js';
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

/**
 * The effort vocabulary — `ChatEffort`, the words a round may ask for
 * (`CHAT_EFFORTS`) and what both agents work at when nothing chose otherwise
 * (`AGENT_EFFORT`) — is `models.ts`'s, beside the models it is spent on. It
 * moved there when the home began keeping its own word per agent: the settings
 * service stores that word, and `models.ts` is the one module it may import
 * from here. Re-exported, so everything that spends an effort keeps reading it
 * from the runtime it is spent in.
 */
export { AGENT_EFFORT, CHAT_EFFORTS, type ChatEffort };

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
 * 250 runs of every kind and a transcript lives a fortnight, so a home that
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
  /**
   * Whether the person asking is the one who had this conversation — the
   * first thing said in it was theirs, which is `ownerOf`'s rule.
   *
   * **Additive, and it fixes a misleading answer rather than hiding a list.**
   * Every member's chats are listed, by design — reading a transcript is shared
   * home-wide — but only its owner can carry one on, and typing into somebody
   * else's answers `410 conversation_ended`, which reads as "this is over"
   * rather than "this is not yours". An app that wants a person's own list
   * shows `mine !== false`. Present whenever the route knows who is asking.
   */
  mine?: boolean;
  /**
   * The **assistant** conversation that handed this one over, when one did.
   *
   * Only ever on an automations chat: the assistant's `handoff` row names the
   * session it started, and this is that link read backwards — the newest
   * handover wins — so an app can say where a conversation came from and go
   * back to it. Absent for one somebody started themselves.
   */
  handedFrom?: string;
}

/**
 * How a person reached the agent, for the run log.
 *
 * `kind` on an `ai_runs` row says which agent spent the money and cannot say
 * this: a spoken request is an ordinary `assist` row, so without it the two
 * halves of one conversation are indistinguishable in the ledger — and they
 * are exactly the two halves that behave differently, one answered at a lower
 * effort with a per-second meter running on the line beside it.
 */
export type ChatVia = 'voice' | 'typed';

/**
 * Where one turn came from and what it asked for — everything about a turn
 * that is *not* its text.
 *
 * Both halves are per **turn** rather than per conversation, and for the same
 * reason: a transport is built once and holds the history, while one
 * conversation is typed in the morning and talked to in the evening.
 */
export interface TurnOrigin {
  effort?: ChatEffort;
  via?: ChatVia;
}

/**
 * Photos one message may carry, and how large each may be once decoded.
 *
 * **Bounds on a Raspberry Pi, not on a phone.** A photo is in this process
 * three times while it is in flight — the request body, the parsed string, and
 * the provider history every round re-serialises — and the smallest supported
 * board has about thirty megabytes of headroom — so a message at the ceiling
 * (four photos, two megabytes of base64 each) is about 24 MB in flight and
 * fits, where three megabytes a photo would not. The app downscales to well
 * under this before sending (a 1280-pixel JPEG is a few hundred kilobytes, and
 * 1568 pixels on the long edge is as large as either vendor reads a photo
 * before shrinking it itself); these are the ceiling a client that does not is
 * held to, not the size the hub expects.
 */
export const CHAT_IMAGE_MAX_COUNT = 4;
export const CHAT_IMAGE_MAX_BYTES = 1.5 * 1024 * 1024;
/**
 * The largest one photo's base64 may be: exactly `CHAT_IMAGE_MAX_BYTES` once
 * decoded, since well-formed base64 is four characters for every three bytes.
 */
export const CHAT_IMAGE_MAX_BASE64 = Math.ceil(CHAT_IMAGE_MAX_BYTES / 3) * 4;

/**
 * The photos this hub is holding for chat rounds, **across every conversation
 * on both surfaces** — and the bound on them.
 *
 * The per-message bounds above are sized for *one* message in flight, and on
 * their own they bound nothing else: a message is acknowledged the moment it is
 * taken and its turn waits in its conversation's chain, holding its photos
 * until that turn has run — so ten messages at the ceiling sent behind one
 * running round pinned about eighty megabytes, and eight conversations each
 * running one held as much again, on a board whose whole headroom is thirty.
 * The portraits and room pictures answer the same constraint by refusing a
 * second drawing rather than queueing it (`portrait_busy`, `picture_busy`);
 * this is that rule measured in bytes, so photos the app has downscaled to a
 * few hundred kilobytes never meet it and a client sending at the ceiling meets
 * it on its second message.
 *
 * **Taken before anything is written and given back when the turn ends** —
 * whichever way it ends, the rebase after it included — by the handle `take`
 * returns, which is idempotent so a path that releases twice cannot free bytes
 * somebody else is holding. Counted in base64 characters, which is what sits in
 * memory, and set at exactly one message at the ceiling.
 */
export class ChatPhotoBudget {
  private held = 0;

  constructor(readonly limit: number = CHAT_IMAGE_MAX_COUNT * CHAT_IMAGE_MAX_BASE64) {}

  /** Characters of photos held right now. */
  get inUse(): number {
    return this.held;
  }

  /**
   * Hold `chars` until the returned release is called, or answer null when
   * that would go past the bound. Nothing is held for a message with no photo.
   */
  take(chars: number): (() => void) | null {
    if (chars <= 0) return () => undefined;
    if (this.held + chars > this.limit) return null;
    this.held += chars;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held -= chars;
    };
  }
}

/**
 * The one budget a hub has. Shared by default — one process is one hub, and
 * the two surfaces are two runtimes over the same memory — and injectable
 * (`ChatRuntimeOptions.photos`) for a suite that wants its own.
 */
export const chatPhotoBudget = new ChatPhotoBudget();

/**
 * A message's photos would take the hub past what it can hold, and nothing was
 * taken: `409 photos_busy`, **a new code for a new situation** with a sentence
 * beside it, so an app that has never met the code still shows something true.
 * Only a message carrying photos can meet it — words alone are queued as they
 * always were — and an app that downscales never does.
 */
export class ChatPhotosBusyError extends Error {
  readonly code = 'photos_busy' as const;
  constructor() {
    super(
      'Your hub is still working on photos sent a moment ago. Send these again when that answer arrives.',
    );
    this.name = 'ChatPhotosBusyError';
  }
}
/** What both vendors accept as an image block, and nothing a phone would not
 *  produce. GIF is left out on purpose: an animated one is a different thing to
 *  send a model, and neither app makes one. */
export const CHAT_IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/**
 * What `GET /hub` says a chat message can carry besides its words.
 *
 * **Presence is the capability**, the `pairing.signInCodes` rule and for its
 * reason: an older hub's zod strips `model`, `effort` and `attachments` without
 * a word and answers 201, so a phone that sent a photo to one would draw a
 * conversation about a picture the model never saw. An app that does not find
 * this block offers none of the three. Static, because that route is the
 * installer's health check and must never throw.
 */
export const CHAT_CAPABILITY = {
  /** A message may name the agent model it is answered on. */
  models: true,
  /**
   * A running round can be stopped part-way — `POST …/chat/:id/stop` on both
   * agents. Presence for the usual reason: an older hub answers that route
   * 404, and a button that can only fail is a dead one.
   */
  stop: true,
  /** The words `effort` takes, from least to most. */
  efforts: CHAT_EFFORTS,
  images: {
    maxCount: CHAT_IMAGE_MAX_COUNT,
    /** Per photo, decoded. */
    maxBytes: CHAT_IMAGE_MAX_BYTES,
    mediaTypes: CHAT_IMAGE_MEDIA_TYPES,
  },
} as const;

/**
 * One photo travelling with a message, for one round.
 *
 * **It is never written down.** `data` reaches the provider in that round's
 * request and nowhere else: the transcript row keeps what the photo *was*
 * (`userRowData`), never its bytes, and the session is rebased after the
 * round (`ChatRuntime.rebase`) so the provider history stops holding it too.
 */
export interface ChatImage {
  mediaType: string;
  /** Base64, without a `data:` prefix. */
  data: string;
  /** The app's own name for its copy, echoed on the row so it can draw it. */
  ref?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
}

/**
 * What one message asks for besides its words — everything a route can pass
 * through to a turn.
 *
 * Absent fields are the old behaviour, which is what an older app sends: the
 * conversation's own model, the transport's own effort, no photos.
 */
export interface ChatTurnRequest {
  /** An agent model id, already checked against what this home can run. */
  model?: string | undefined;
  effort?: ChatEffort | undefined;
  images?: readonly ChatImage[] | undefined;
}

/**
 * How many bytes a base64 string decodes to, without decoding it.
 *
 * Measured from the length rather than by decoding a two-megabyte string to
 * learn how long it is — the number is exact for well-formed base64, which the
 * route has already insisted on.
 */
export function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/**
 * What a user row records about the photos it was sent with: what they were,
 * never what they looked like.
 */
interface StoredAttachment {
  type: 'image';
  mediaType: string;
  ref?: string;
  width?: number;
  height?: number;
  bytes: number;
}

/**
 * The person's own row's `data`, for a message that asked for anything
 * besides its words — `undefined` for one that did not, so an older app's
 * message is stored exactly as it always was.
 *
 * **Only the keys the request named**, so a row says what was *asked* rather
 * than what the hub filled in; and **never the base64**, which is the rule this
 * function exists to keep in one place. A row is a few hundred bytes by design,
 * and a photo in it would be a fortnight of somebody's camera roll on an SD
 * card.
 */
function userRowData(
  turn: ChatTurnRequest | undefined,
  /** The message was a photo and no words — see `photoCaption`. */
  wordless = false,
): Record<string, unknown> | undefined {
  if (turn === undefined) return undefined;
  const attachments: StoredAttachment[] = (turn.images ?? []).map((image) => ({
    type: 'image' as const,
    mediaType: image.mediaType,
    ...(image.ref !== undefined ? { ref: image.ref } : {}),
    ...(image.width !== undefined ? { width: image.width } : {}),
    ...(image.height !== undefined ? { height: image.height } : {}),
    bytes: base64Bytes(image.data),
  }));
  const data: Record<string, unknown> = {
    ...(turn.model !== undefined ? { model: turn.model } : {}),
    ...(turn.effort !== undefined ? { effort: turn.effort } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(wordless && attachments.length > 0 ? { wordless: true } : {}),
  };
  return Object.keys(data).length > 0 ? data : undefined;
}

/** How many photos a stored row says it was sent with. */
function photoCount(row: { data?: unknown }): number {
  const attachments = (row.data as { attachments?: unknown } | null | undefined)?.attachments;
  return Array.isArray(attachments) ? attachments.length : 0;
}

/**
 * Whether a stored row is a photo sent with no words — its `text` the hub's
 * caption rather than anything the person said.
 *
 * An empty `text` counts too, which no row this hub writes has: it is the
 * reading that stays true whichever way a row came to have no words.
 */
export function isWordless(row: { text: string; data?: unknown }): boolean {
  if (photoCount(row) === 0) return false;
  return (
    (row.data as { wordless?: unknown } | null | undefined)?.wordless === true ||
    row.text.trim().length === 0
  );
}

/** "1 photo", "2 photos". */
function photos(count: number): string {
  return `${count} photo${count === 1 ? '' : 's'}`;
}

/**
 * The `text` a row stores for a message that was only a photo — the list's
 * own words for one: "Photo", "2 photos".
 *
 * **Because an older app draws a person's row from `text` alone.** `message`
 * was `min(1)` until a photo could be sent on its own, so no build that has
 * shipped has ever met an empty one — and drawn from an empty `text`, a
 * picture somebody sent read on an older phone as an empty bubble with an
 * answer about nothing beneath it. A caption is the fallback that stays true,
 * the `activity.message` rule; `data.wordless` says it is the hub's and not
 * the person's, so an app that draws the photo leaves it off, and the recap,
 * the voice's history and the list read it as no words at all.
 */
export function photoCaption(count: number): string {
  return count === 1 ? 'Photo' : photos(count);
}

export interface ChatTurnContext {
  /**
   * What this round works at, when it is not what the conversation works at.
   *
   * Absent is the ordinary case and means the transport's own setting. Present
   * is one round asking for something else — today only a spoken one, where
   * the reply is a person waiting in a room rather than a message they will
   * read when they get to it.
   */
  effort?: ChatEffort;
  /**
   * Photos that travel with this message, for this round only.
   *
   * Each agent hands them to its transport with the person's words (or with
   * the answer to its question). Absent is every message before this existed,
   * and keeps the request byte-identical to what it was.
   */
  images?: readonly ChatImage[];
  /**
   * The person's stop for this turn — aborted by `ChatRuntime.stop`.
   *
   * Each agent's loop listens to it through a `TurnAbort` beside its watchdog,
   * and winds the turn down at the next safe point: mid-reply, with what had
   * reached the page; between tool calls, with the rest answered as not done;
   * between rounds, with every call answered. The turn it ends with carries
   * `halted`, which is how the runtime knows to say so.
   */
  signal?: AbortSignal;
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
  /**
   * What this conversation works at when a turn does not ask for something
   * else — read back for the run log rather than re-derived, the rule
   * `modelId` follows: the log is about what *ran*.
   */
  readonly effort: ChatEffort;
  readonly provider: string;
}

/**
 * A turn the person stopped part-way, carried on whichever arm it wound down
 * as — so what it had already produced is written down exactly as it would
 * have been, and the note saying it stopped follows.
 */
export interface Halted {
  /**
   * Something had already happened before the stop arrived — a device worked,
   * a scene pressed, a job handed over, a rule saved — which is what the note
   * has to say stays done. A stop takes nothing back.
   */
  acted: boolean;
}

/** The three arms every agent has, whatever else it can end a turn with. */
export type CommonTurn =
  | { kind: 'question'; question: AskUser }
  | { kind: 'said'; text: string; halted?: Halted }
  | { kind: 'stopped'; reason: string };

/** The note a stopped turn ends on — quiet, and true whatever had happened. */
const HALTED_NOTE = 'Stopped.';
const HALTED_NOTE_ACTED = 'Stopped. What was already done stays done.';

/**
 * What the model is told about a turn the person stopped, on the next one —
 * reaching it and never the transcript, the `revive()` channel. The partial
 * reply is in its history already; what it cannot see from there is that it
 * was cut short rather than finished, and it should not pick the old request
 * back up unasked.
 */
const HALTED_PRIMING =
  '(They stopped your last answer part-way through. What you had written by then is what ' +
  'they saw, and nothing you had not yet done was done — do not carry on with it unless ' +
  'they ask.)';

/** The `halted` a turn arm carries, whichever agent's arm it is. */
function haltOf(turn: { kind: string }): Halted | undefined {
  return (turn as { halted?: Halted }).halted;
}

/**
 * The conversation cannot start, for a reason somebody can fix.
 *
 * Two codes rather than one, because they lead to two different screens: add
 * a key, or add a key *of the other kind*. Each carries a sentence as well, so
 * an app that meets a code a later build added still has something true to
 * show — the `activity.message` rule applied to a refusal.
 *
 * **There was a third, `ai_disabled`, and it is gone from here on purpose.**
 * That switch is device recognition's, and a conversation no longer asks it;
 * the code survives only on the recognition routes (`remap`, `repair`). Both
 * apps still read it, because a hub older than this one sends it for a chat.
 *
 * **Everything that can refuse a conversation has to end up here**, on either
 * surface. One of these once threw an `AiUnavailableError` instead, which the
 * route rethrew into a bare 500, and the app drew "The hub answered 500." over
 * a home that was configured perfectly well, just not for this.
 */
export class AgentNotConfiguredError extends Error {
  constructor(
    readonly code: 'ai_not_configured' | 'automation_needs_anthropic',
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
  /** The photos budget — `chatPhotoBudget`, the hub's one, unless a suite
   *  hands in its own. */
  photos?: ChatPhotoBudget;
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
   * The stop for the turn now running, while one is — set when the turn
   * begins and cleared when it ends, so `stop()` reaches exactly the round
   * somebody is watching and never a message still waiting behind it.
   */
  halt?: AbortController | undefined;
  /**
   * What the turn now running is — its effort and how it was asked — resolved
   * at the moment it began, for the `ai_runs` row that follows it.
   */
  origin?: { effort: ChatEffort; via: ChatVia };
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
  /**
   * When the round now running began, until the first row it writes takes it
   * as `tookMs`.
   *
   * Beside `steps` and with the same rule — the round's first non-user row
   * carries it, whichever kind that row is — so a conversation read back says
   * how long the working took as well as what it was.
   */
  roundStartedAt?: number | undefined;
  /**
   * The conversation was put in place by a rebase or a model switch and has
   * not run a round yet.
   *
   * What `record` asks before writing a row with nothing in it: the ledger
   * writes a conversation's *first* row even at zero, which is right for one
   * that ran and failed before spending, and wrong for one that never ran at
   * all — a photo's rebase closed two hours later by the idle sweep would
   * otherwise leave a `$0` run in a log that keeps 250 of them.
   */
  unrun?: boolean | undefined;
  /** The artefact this conversation is about, for the ledger and for a
   *  revived conversation's opening context. */
  topic?: string | undefined;
  /**
   * What the conversation was **opened** about — the route's `automationId`,
   * or for a revived one the rule its rows say it was editing — which is what
   * a conversation put in its place by a switch or a rebase is opened with.
   *
   * Not `topic`, which the automations agent fills with the first rule a
   * conversation *writes* (for the ledger): reopening on that framed a chat
   * that had written two rules as an edit of the first, told to submit with
   * `replaces` set to it while the person was talking about the second.
   */
  openedTopic?: string | undefined;
  /**
   * The first row a *revived* conversation's memory holds — its recap is the
   * tail of the transcript — so a switch or rebase recaps what the history it
   * replaces remembered rather than more. Absent for one opened fresh, whose
   * memory is the whole conversation.
   */
  recallFrom?: string | undefined;
  /**
   * The conversation could not be rebased after a photo and has been dropped
   * from memory, while turns queued on this object may still be waiting.
   *
   * Those turns must not run: `conversation` still holds the photo, and the
   * key it was opened with may be the one somebody has just removed. Each is
   * answered with a note instead; the next message revives the conversation
   * from its transcript.
   */
  dropped?: boolean | undefined;
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
function recapOf(
  rows: ChatMessageWire[],
  /** Older rows of the same conversation left out of this record. */
  omitted = 0,
): string {
  const lines = rows.map((row) => {
    switch (row.role) {
      case 'user': {
        // A photo is the one thing a recap cannot carry, so it says one was
        // there: a model told "what is this?" with nothing beside it would
        // otherwise answer a question about a picture it has never seen as if
        // the question were the whole of it. And a photo sent on its own says
        // only that — its `text` is the hub's caption, not something said.
        const sent = photoCount(row);
        if (sent === 0) return `They said: ${row.text}`;
        return isWordless(row)
          ? `They sent ${photos(sent)} (no longer available).`
          : `They said: ${row.text} (with ${photos(sent)}, no longer available)`;
      }
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
    RECAP_OPENING,
    'follows is the record of what was said, so read it as history rather than',
    'as your own memory, and carry on from the end of it.',
    // Said rather than implied when the record is a tail: the closing line
    // calls it the whole of it, which is true of the record and not of the
    // conversation.
    ...(omitted > 0
      ? [`(The ${omitted} oldest ${omitted === 1 ? 'entry is' : 'entries are'} left out of this record.)`]
      : []),
    '',
    ...lines,
    '',
    RECAP_CLOSING,
  ].join('\n');
}

/** The recap's first and last lines, so a pending one can be recognised. */
const RECAP_OPENING = 'This conversation is being picked up again. You do not remember it — what';
const RECAP_CLOSING = 'That is the whole of it. Their next message follows.';

/**
 * What a session's pending priming says besides a recap, for a conversation
 * about to be primed with a new one.
 *
 * **A new conversation is primed with the whole record, so an older recap
 * waiting to be sent is superseded rather than added to** — two copies of the
 * same history is a model told everything twice. What is *not* a recap stays:
 * the ids of rules written this turn (`rememberSaved`) and a spoken turn's
 * marker are facts about the conversation that no row carries.
 */
function withoutRecap(priming: string | undefined): string | undefined {
  if (priming === undefined || !priming.startsWith(RECAP_OPENING)) return priming;
  const end = priming.indexOf(RECAP_CLOSING);
  const rest = end < 0 ? '' : priming.slice(end + RECAP_CLOSING.length).trim();
  return rest.length > 0 ? rest : undefined;
}

/**
 * A recap of `rows` for a conversation put in another's place, followed by
 * whatever else was waiting to be said.
 *
 * **Everything the conversation it replaces remembered — no more, no less.**
 * A switch or a rebase is not a revival: the provider history being swapped
 * out held every row since the conversation began, so recapping only the last
 * `RECAP_MAX_ROWS` cut the original request out of a chat that had never
 * stopped, the first time somebody sent a photo or picked another model.
 * `recallFrom` is where a *revived* one's memory begins (its own recap was a
 * tail), so a rebase after a revival carries exactly what that history held
 * rather than growing back to rows it had already let go.
 */
function primingFor(
  rows: ChatMessageWire[],
  pending: string | undefined,
  recallFrom: string | undefined,
): string | undefined {
  const kept = withoutRecap(pending);
  const from = recallFrom === undefined ? -1 : rows.findIndex((row) => row.id === recallFrom);
  const recalled = from > 0 ? rows.slice(from) : rows;
  if (recalled.length === 0) return kept;
  const recap = recapOf(recalled, rows.length - recalled.length);
  return kept === undefined ? recap : `${recap}\n${kept}`;
}

/**
 * The model the person last chose for a stored conversation, if they chose one.
 *
 * The newest user row **that named a model**, because a message that names
 * none leaves a conversation on what it was running — so a revived one keeps
 * the model the live one would have had.
 */
function modelFromRows(rows: ChatMessageWire[]): string | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.role !== 'user') continue;
    const model = (row.data as { model?: unknown } | null | undefined)?.model;
    if (typeof model === 'string' && model.length > 0) return model;
  }
  return undefined;
}

/**
 * The rows a conversation has already been through by the time the turn for
 * `messageId` begins (`includeOwn` false) or ends (`includeOwn` true) — the
 * record a conversation put in its place is primed with.
 *
 * **Not "everything before the message", and not "everything".** A message
 * sent while a round is running is written the moment it is taken (`say`), so
 * its row lands *ahead* of the answer that round goes on to write: cutting the
 * transcript at the message would lose an answer the person has already read.
 * And a message sent after this one is written already too, waiting its turn
 * in the chain — it is not history yet, and recapping it would hand the model
 * that message twice, once as the past and once as the next thing said. So
 * every row is kept but the person's own from this message on, and this
 * message's own row is history only once its round is over.
 *
 * Turns run in the order `say` takes them, so a person's row after this one is
 * always a turn still to come. A message the hub cannot find (its row was
 * never written) leaves every row in, which is what a revival does.
 */
function settledRows(
  rows: ChatMessageWire[],
  messageId: string | undefined,
  includeOwn: boolean,
): ChatMessageWire[] {
  const at = messageId === undefined ? -1 : rows.findIndex((row) => row.id === messageId);
  if (at < 0) return rows;
  return rows.filter(
    (row, index) => index < at || row.role !== 'user' || (includeOwn && index === at),
  );
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
    /**
     * The agent model this conversation was asked to run on, when it was.
     *
     * Resolved by the subclass through `requestedAgentModel`, so the vendor
     * and key rules stay where they are written; an id it cannot run right now
     * falls back to the home's own setting, as an unchosen conversation has
     * always run on. Absent is that setting.
     */
    model?: string | undefined;
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

  /**
   * Which conversation on another surface handed each of this surface's over,
   * by this surface's session id. Most surfaces are never handed anything and
   * take the default; the automations agent is the one that is.
   */
  protected async handedOver(): Promise<Map<string, string>> {
    return new Map();
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
    /** What the first message asks for besides its words. A model named here
     *  is what the conversation *opens* on, rather than a switch after it. */
    turn?: ChatTurnRequest | undefined;
  }): Promise<ChatReply> {
    // Before anything else — an eviction, a conversation opened, a row — so a
    // message refused for its photos has changed nothing.
    const release = this.holdPhotos(input.turn);
    try {
      this.sweep();
      if (this.sessions.size >= CHAT_MAX_SESSIONS) {
        // Oldest first: a conversation nobody has touched is the one to lose.
        const oldest = [...this.sessions.values()].sort((a, b) => a.lastAt - b.lastAt)[0];
        if (oldest) await this.close(oldest.id);
      }

      // Minted before the conversation, because a tool context is built with it
      // — see `openConversation`.
      const session = await this.open(randomUUID(), input.memberId, input.topic, input.turn?.model);
      return await this.say(session, input.message, 'send', undefined, input.turn, release);
    } catch (error) {
      release();
      throw error;
    }
  }

  /**
   * Hold a message's photos against the hub's budget, or refuse it
   * (`ChatPhotosBusyError`) having held nothing. The release is the turn's to
   * call when it ends — `exchange` does — and the caller's if the message is
   * never taken.
   */
  private holdPhotos(turn: ChatTurnRequest | undefined): () => void {
    const chars = (turn?.images ?? []).reduce((sum, image) => sum + image.data.length, 0);
    const release = (this.base.photos ?? chatPhotoBudget).take(chars);
    if (release === null) throw new ChatPhotosBusyError();
    return release;
  }

  /**
   * A conversation at an id somebody else chose, with nothing said in it yet.
   *
   * `start()` is this plus a first message, and that is the ordinary way in.
   * The seam exists for the **voice**, where the id is minted before a word is
   * spoken (`beginVoice`) and the first thing that happens to the session is a
   * question arriving from a sideband rather than from a route — so there is no
   * transcript to revive from and no message to start with.
   */
  protected async open(
    sessionId: string,
    memberId: string,
    topic?: string | undefined,
    model?: string | undefined,
  ): Promise<ChatSession<Turn>> {
    const conversation = await this.openConversation({
      memberId,
      topic,
      sessionId,
      ...(model !== undefined ? { model } : {}),
    });
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
      ...(topic !== undefined ? { topic, openedTopic: topic } : {}),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /** Continue one. A typed reply to a question is an answer, not a new
   *  message — the conversation itself decides which, since only it knows
   *  whether a tool call is outstanding. */
  async reply(
    sessionId: string,
    memberId: string,
    text: string,
    turn?: ChatTurnRequest,
  ): Promise<ChatReply | null> {
    // Held before a conversation is revived for it, the rule `start` keeps.
    const release = this.holdPhotos(turn);
    try {
      const session =
        this.sessions.get(sessionId) ?? (await this.revive(sessionId, memberId, turn?.model));
      if (!session || session.memberId !== memberId) {
        release();
        return null;
      }
      return await this.say(session, text, 'auto', undefined, turn, release);
    } catch (error) {
      release();
      throw error;
    }
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
  protected async revive(
    sessionId: string,
    memberId: string,
    /** The model the message that woke it asked for — opened on directly,
     *  rather than revived on one model and switched straight to another. */
    model?: string | undefined,
  ): Promise<ChatSession<Turn> | null> {
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
    /**
     * **On the model the person last chose for it**, read back off their own
     * rows — or the one this message asks for. Without this a chat somebody
     * had moved to Sonnet came back on the home's default after every restart
     * and idle sweep, which is most of the time a conversation is reopened,
     * with nothing on screen to say it had changed.
     */
    const chosen = model ?? modelFromRows(rows);
    const recalled = rows.slice(-RECAP_MAX_ROWS);
    const conversation = await this.openConversation({
      memberId,
      topic,
      sessionId,
      ...(chosen !== undefined ? { model: chosen } : {}),
    });
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
      // The tail, because what was being discussed when it stopped is what it
      // is about — and where that tail begins is where this memory begins.
      priming: recapOf(recalled, rows.length - recalled.length),
      ...(rows.length > recalled.length ? { recallFrom: recalled[0]!.id } : {}),
      ...(topic !== undefined ? { topic, openedTopic: topic } : {}),
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
    origin?: TurnOrigin,
    turn?: ChatTurnRequest,
    /** Gives back the photos `holdPhotos` held for this message, once its turn
     *  is over — however it ends. */
    release?: () => void,
  ): Promise<ChatReply> {
    // What was asked besides the words goes on the person's own row — the
    // model, the effort, what each photo was — and never a photo itself. A
    // photo sent with no words stores a caption an older app can draw, and
    // says so; the model is still sent the words the person actually sent.
    const sent = turn?.images?.length ?? 0;
    const wordless = sent > 0 && text.trim().length === 0;
    const written = await this.write(
      session,
      'user',
      wordless ? photoCaption(sent) : text,
      userRowData(turn, wordless),
      session.memberId,
    );
    session.lastAt = Date.now();
    /**
     * **The effort somebody picked is this turn's**, the way a spoken turn's
     * `low` is — and a spoken turn passes its own origin, which keeps winning:
     * the voice is answering a person standing in a room, whatever the chat's
     * picker last said.
     */
    const asked: TurnOrigin | undefined =
      origin ?? (turn?.effort !== undefined ? { effort: turn.effort } : undefined);
    session.inFlight = session.inFlight.then(() =>
      this.exchange(session, text, how, asked, turn, written.id, release),
    );
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
  async list(
    /** Who is asking, so each conversation can say whether it is theirs.
     *  Absent leaves `mine` off rather than guessing. */
    memberId?: string,
  ): Promise<ChatSummaryWire[]> {
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
        // Small by construction — a user row's data is the model, the effort
        // and what each photo *was*, never its bytes — and it is what titles a
        // conversation that began with a picture.
        data: automationChatMessages.data,
        memberId: automationChatMessages.memberId,
      })
      .from(automationChatMessages)
      .where(and(this.surfaceFilter, eq(automationChatMessages.role, 'user')))
      .orderBy(asc(automationChatMessages.at));

    const titles = new Map<string, string>();
    /** Whose each conversation is: the first thing said in it, `ownerOf`'s
     *  rule, read off the rows this query already has. */
    const owners = new Map<string, string | null>();
    for (const row of said) {
      if (titles.has(row.sessionId)) continue;
      // A conversation that opened with a picture and no words is called what
      // it is, rather than "Untitled conversation" — the caption its row
      // stores, re-derived so a row with no words at all reads the same.
      titles.set(row.sessionId, isWordless(row) ? photoCaption(photoCount(row)) : row.text);
      owners.set(row.sessionId, row.memberId);
    }

    const ledger = await this.base.runs.spendBySession();
    const parents = await this.handedOver();

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
          ...(memberId !== undefined
            ? { mine: (owners.get(session.sessionId) ?? null) === memberId }
            : {}),
          ...(parents.has(session.sessionId)
            ? { handedFrom: parents.get(session.sessionId)! }
            : {}),
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

  /**
   * Stop the round this conversation is running, part-way.
   *
   * **The round somebody is watching, and nothing else.** A message sent while
   * it ran is still waiting its turn and still runs — stopping an answer is not
   * taking back what was said after it — and a job the assistant handed over
   * goes on in that agent's own conversation, which has its own stop.
   *
   * Answered at once, never when the round has wound down: the turn ends at the
   * next safe point (`TurnAbort`) and says so on the socket like any other, with
   * what had reached the page kept as the answer and a note that it stopped. So
   * `stopped` means a round was told to stop, and `idle` that none was running —
   * a conversation the hub holds no memory of included, since a round runs only
   * in memory. Only the person whose conversation it is may stop it: the
   * session's own member, `reply`'s rule.
   */
  stop(sessionId: string, memberId: string): 'stopped' | 'idle' | 'not_yours' {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return 'idle';
    if (session.memberId !== memberId) return 'not_yours';
    if (session.halt === undefined) return 'idle';
    session.halt.abort();
    return 'stopped';
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
    how: 'send' | 'answer' | 'auto',
    origin?: TurnOrigin,
    turn?: ChatTurnRequest,
    /** The person's own row for this message, which a model switch recaps up
     *  to rather than through. */
    messageId?: string,
    /** Gives this message's photos back to the hub's budget. */
    release?: () => void,
  ): Promise<void> {
    // This turn's stop, from the moment it begins — before a model switch, so
    // a stop pressed while the conversation is being moved still lands.
    const halt = new AbortController();
    session.halt = halt;
    try {
      await this.exchangeHeld(session, text, how, origin, turn, messageId, halt.signal);
    } finally {
      if (session.halt === halt) session.halt = undefined;
      // Whatever the turn ended as — answered, refused, dropped, its model
      // unusable — the photos it held are let go with it, the rebase after it
      // included.
      release?.();
    }
  }

  private async exchangeHeld(
    session: ChatSession<Turn>,
    text: string,
    how: 'send' | 'answer' | 'auto',
    origin: TurnOrigin | undefined,
    turn: ChatTurnRequest | undefined,
    messageId: string | undefined,
    halt: AbortSignal,
  ): Promise<void> {
    /**
     * **A conversation dropped behind this turn's back is not run on.** A
     * rebase that could not reopen it (`rebase`) left the old conversation on
     * this object, photo and captured key included; a turn queued before that
     * happened would otherwise run on it and send the photo again. Said in a
     * note, with the spinner taken down; the next message revives it.
     */
    if (session.dropped === true) {
      await this.write(
        session,
        'note',
        'Your hub couldn’t carry this conversation on. Send that again to pick it back up.',
      ).catch(() => undefined);
      this.settle(session, 'stopped');
      return;
    }
    /**
     * **A different model is a different conversation, opened when the turn
     * begins.** Asked here rather than when the message was taken because turns
     * are chained: a switch queued behind a running turn must not pull the
     * conversation out from under it.
     */
    if (turn?.model !== undefined && turn.model !== session.conversation.modelId) {
      if (!(await this.switchModel(session, turn.model, messageId))) return;
    }
    try {
      // Asked when the turn begins, never when it was queued — and after any
      // switch above, since a fresh conversation has no question outstanding.
      const mode =
        how === 'auto' ? (session.conversation.awaitingAnswer() ? 'answer' : 'send') : how;
      await this.runExchange(session, text, mode, halt, origin, turn);
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
    // A round that wrote nothing leaves no clock behind for a later row.
    session.roundStartedAt = undefined;
    // A photo is in the provider history now, and it leaves before the next
    // turn begins — whatever this one ended as. See `rebase`.
    if ((turn?.images?.length ?? 0) > 0) await this.rebase(session, messageId);
  }

  /**
   * Move a conversation onto another model, for the turn about to begin.
   *
   * **Recapped, never carried over**: a vendor's history is its own shape —
   * Anthropic's signed thinking blocks, OpenAI's encrypted reasoning — and
   * neither is something the other will take, nor a different model of the
   * same vendor's guaranteed to. So this is `revive()` on purpose: a fresh
   * conversation on the new model, primed with the record of everything
   * settled when this turn begins (`settledRows` — an answer written after
   * this message was taken included, a message still queued behind it not;
   * the message itself is the turn about to run). What is lost is what revival
   * loses — the model's reasoning and an outstanding question, which the
   * person answering is now simply a message.
   *
   * **The old conversation's spend is written down first**, which is the half
   * that is easy to get wrong: `record` writes the delta between what a
   * conversation has cost and `recordedUsd`, so swapping the conversation
   * without banking would lose whatever it ran up since its last row, and not
   * resetting the cursor afterwards would under-record the new one until it
   * caught up with the old one's total.
   *
   * Answers false when the turn should not run — the model can no longer be
   * used, or the new conversation could not be opened — having said so in a
   * note and taken the app's spinner down, the provider-failure path's rule.
   */
  private async switchModel(
    session: ChatSession<Turn>,
    model: string,
    messageId: string | undefined,
  ): Promise<boolean> {
    try {
      const usable = await this.base.settings.agentProviders();
      const wanted = requestedAgentModel(model, usable);
      if (wanted === null) {
        // The route checked this a moment ago; a key removed in between is
        // the only way here, and running a model nobody picked would be the
        // picker lying about what answered.
        throw new AgentNotConfiguredError(
          'ai_not_configured',
          'That model can’t be used on this hub right now. Pick another one and send it again.',
        );
      }
      if (wanted.modelId === session.conversation.modelId) return true;

      const conversation = await this.openConversation({
        memberId: session.memberId,
        // What it was opened about, never the first rule it wrote — see
        // `openedTopic`.
        topic: session.openedTopic,
        sessionId: session.id,
        model: wanted.modelId,
      });
      // Everything said before this message — including an answer written
      // after it was taken — and nothing queued behind it.
      const before = settledRows(await this.transcript(session.id), messageId, false);
      await this.settleSpend(session);
      this.replaceConversation(session, conversation, before);
      this.base.log.info(
        { sessionId: session.id, surface: this.surface, model: wanted.modelId },
        'chat: moved onto another model',
      );
      return true;
    } catch (error) {
      const message =
        error instanceof AgentNotConfiguredError
          ? error.message
          : `That model could not be started: ${(error as Error).message}`;
      this.base.log.warn({ err: error }, 'chat: could not move onto another model');
      await this.write(session, 'note', message).catch(() => undefined);
      this.settle(session, 'stopped');
      return false;
    }
  }

  /**
   * Let a photo go, once the round it was sent for is over.
   *
   * **The provider history is the one place a photo outlives its round**, and
   * it is the one place this hub cannot edit: Fable 5.1 binds each thinking
   * block to everything ahead of it, so a conversation may only ever be
   * appended to — cutting an image block out of the middle of one is a
   * conversation the API refuses. Left there, every photo somebody sent would
   * sit in memory for the session's two-hour life and be re-sent, and paid
   * for, on every round after it, on a board with thirty megabytes to spare.
   *
   * So the session is **rebased** the way a model switch is: the spend so far
   * written down, a fresh conversation on the same model, primed with the
   * record of everything said — which says a photo was sent and is no longer
   * available. The old conversation, and the photo with it, is released.
   *
   * Never throws, and runs in the turn chain so it is done before the next
   * queued message begins. **Whether or not the session is still in the map**:
   * one closed or evicted while its round ran still has the turns queued on
   * it to run (`close` lets them finish), and skipping the rebase there sent
   * the photo again with each of them. The map is never written here, so a
   * closed session is not brought back by it.
   *
   * A conversation that cannot be reopened (its key removed a moment ago) is
   * dropped from memory instead and marked `dropped`, so a turn already queued
   * on it is answered with a note rather than run on the history still holding
   * the photo; the next message revives it from the transcript, which is the
   * ordinary path.
   */
  private async rebase(session: ChatSession<Turn>, messageId: string | undefined): Promise<void> {
    try {
      const conversation = await this.openConversation({
        memberId: session.memberId,
        topic: session.openedTopic,
        sessionId: session.id,
        model: session.conversation.modelId,
      });
      await this.settleSpend(session);
      // The round just over is history now; a message queued behind it is not.
      const settled = settledRows(await this.transcript(session.id), messageId, true);
      this.replaceConversation(session, conversation, settled);
    } catch (error) {
      this.base.log.warn({ err: error }, 'chat: could not rebase after a photo; dropping it');
      await this.settleSpend(session);
      session.dropped = true;
      if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
    }
  }

  /**
   * Write down what the conversation about to be replaced has spent since its
   * last row — and only if it has, so a switch on a conversation that has not
   * run since adds no empty row to the ledger.
   */
  private async settleSpend(session: ChatSession<Turn>): Promise<void> {
    if (session.conversation.costUsd() > session.recordedUsd) await this.bank(session, true);
  }

  /**
   * Put a fresh conversation where the old one was, primed with `rows`.
   *
   * The ledger cursor and the clock start again with it, as a revived one's
   * do: the new conversation has spent nothing, and `durationMs` is about the
   * conversation that is running.
   */
  private replaceConversation(
    session: ChatSession<Turn>,
    conversation: AgentConversation<Turn>,
    rows: ChatMessageWire[],
  ): void {
    session.conversation = conversation;
    session.recordedUsd = 0;
    session.unrun = true;
    session.startedAt = Date.now();
    session.priming = primingFor(rows, session.priming, session.recallFrom);
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

  /**
   * How hard this agent works on a turn that asked for no effort of its own:
   * the home's word (`PATCH /settings/ai`), or the conversation's own where
   * the setting cannot be read — a turn is not worth failing over which of two
   * defaults it runs at.
   */
  private async homeEffort(session: ChatSession<Turn>): Promise<ChatEffort> {
    try {
      return await this.base.settings.agentEffort(this.surface === 'assistant' ? 'assistant' : 'automations');
    } catch {
      return session.conversation.effort;
    }
  }

  private async runExchange(
    session: ChatSession<Turn>,
    text: string,
    how: 'send' | 'answer',
    /** The person's stop for this turn — see `stop`. */
    halt: AbortSignal,
    origin?: TurnOrigin,
    request?: ChatTurnRequest,
  ): Promise<void> {
    // **What this turn was, for the row it is about to write.** Kept on the
    // session because `record` runs after the turn and takes only the
    // session; turns are chained per conversation, so the value cannot belong
    // to a different one by the time it is read.
    //
    // **The effort is the turn's**: what the message or the voice asked for,
    // and otherwise the home's own word for this agent — read now rather than
    // when the conversation opened, because it is a setting that moves while a
    // conversation stays open, and sent on every round rather than left to the
    // transport's own, so what the run log records is what was asked for.
    const effort = origin?.effort ?? (await this.homeEffort(session));
    session.origin = {
      effort,
      // A chat turn is typed unless something says otherwise, which is the
      // honest default: `askAloud` is the only caller that says otherwise.
      via: origin?.via ?? 'typed',
    };
    // A round's working belongs to that round. Cleared here rather than after
    // the rows are written, so a turn that throws between the two cannot hand
    // its steps to the next answer.
    session.steps = [];
    // And so does its clock, which the first row it writes takes as `tookMs`.
    session.roundStartedAt = Date.now();
    // Whatever this round costs — nothing included, if it fails before the
    // first request — is a run the ledger should hear about.
    session.unrun = false;
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
        effort,
        // This round's photos and nobody else's: they are in the request the
        // model reads now, and `rebase` lets them go once the round is over.
        ...(request?.images !== undefined && request.images.length > 0
          ? { images: request.images }
          : {}),
        signal: halt,
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
      // What was reasoned before the round ended belongs to its working, the
      // failed round's included — it is the round with the most to explain.
      settleReasoning();
      if (halt.aborted) {
        /**
         * **A stop is not a failure, whatever it threw on the way out.** Each
         * loop turns the person's stop into a turn of its own, so reaching here
         * with it is a path nobody planned for — and "something went wrong"
         * over an answer somebody stopped on purpose is the one sentence that
         * is certainly untrue. Nothing is known about what it had done, so the
         * note claims nothing about it either.
         */
        this.base.log.warn({ err: error }, 'chat turn threw while stopping');
        session.lastAt = Date.now();
        await this.noteHalt(session, { acted: false });
        await this.bank(session, true);
        this.settle(session, 'stopped');
        return;
      }
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

    // A turn that ends straight after thinking — a stop mid-thought, above all
    // — leaves that reasoning with no later step to settle it.
    settleReasoning();
    session.lastAt = Date.now();
    await this.recordTurn(session, turn);
    /**
     * **A stopped turn says so, after whatever it had produced** — the words
     * that reached the page, the cards for what it did — so the transcript
     * reads as it happened: the answer as far as it got, then the stop. The
     * note is the row the round's working goes on when nothing came before it.
     */
    const halted = haltOf(turn);
    if (halted !== undefined) await this.noteHalt(session, halted);
    await this.bank(session, true);
    this.settle(session, turn.kind);
  }

  /**
   * Write that a turn was stopped, and tell the model on its next one.
   *
   * `data.stopped` is what an app draws it quietly by rather than as a
   * failure; an app that has never heard of it shows the sentence, which is
   * true on its own.
   */
  private async noteHalt(session: ChatSession<Turn>, halted: Halted): Promise<void> {
    await this.write(session, 'note', halted.acted ? HALTED_NOTE_ACTED : HALTED_NOTE, {
      stopped: true,
    });
    session.priming =
      session.priming === undefined ? HALTED_PRIMING : `${session.priming}\n${HALTED_PRIMING}`;
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
      case 'said': {
        // Empty only for a turn stopped before it said a word, whose note is
        // the whole of its answer — every loop hands back words otherwise.
        const said = (turn as unknown as CommonTurn & { kind: 'said' }).text;
        return said.trim().length > 0 ? [await this.write(session, 'agent', said)] : [];
      }

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
    /**
     * **How long the round took, on the same row its working goes on.** An
     * integer of milliseconds from the moment the round began to the moment
     * it wrote its first answer — which is the wait somebody sat through, and
     * what an app turns into "worked for 12s" on a conversation read back.
     * Additive: an app that has never heard of it draws the row as it did.
     */
    const startedAt = role === 'user' ? undefined : session.roundStartedAt;
    if (startedAt !== undefined) session.roundStartedAt = undefined;
    const tookMs = startedAt === undefined ? undefined : Math.max(0, Math.round(Date.now() - startedAt));
    const payload =
      steps.length > 0 || tookMs !== undefined
        ? {
            ...(typeof data === 'object' && data !== null ? data : {}),
            ...(steps.length > 0 ? { steps } : {}),
            ...(tookMs !== undefined ? { tookMs } : {}),
          }
        : data;

    return this.writeRow(session.id, role, text, payload, memberId);
  }

  /**
   * One transcript row, against a session id rather than a live conversation.
   *
   * Split out of `write` for the voice, which has rows to record and no
   * provider conversation to hang them on — somebody speaking and a lamp
   * going off is a real exchange in this transcript even though no model on
   * this hub was asked anything. Everything about a row that is the same
   * either way lives here; what `write` keeps is the step capture, which
   * belongs to a round.
   */
  protected async writeRow(
    sessionId: string,
    role: ChatMessageWire['role'],
    text: string,
    payload?: unknown,
    memberId?: string,
  ): Promise<ChatMessageWire> {
    const row = {
      sessionId,
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
    // again when it ends, and the second of those is usually zero — and one
    // swapped in by a rebase or a switch that has not run has nothing to say
    // at all (`unrun`).
    if (spent <= 0 && (session.recordedUsd > 0 || session.unrun === true)) return;
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
      // What this turn actually was. Both are read back rather than
      // re-derived, the rule `modelId` follows: a log is about what ran, and
      // every setting behind it moves.
      ...(session.origin !== undefined
        ? { effort: session.origin.effort, via: session.origin.via }
        : {}),
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
