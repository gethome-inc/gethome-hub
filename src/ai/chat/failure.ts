import type { AiProvider } from '../../core/settings.js';
import { AiUnavailableError, readableFailure, type AiFailureKind } from '../errors.js';
import { agentCounterpart, modelLabel, type UsableProviders } from '../models.js';

/**
 * A round that could not be answered, said in words somebody can act on — and,
 * where the home has the other vendor's key, the model that could answer it
 * instead.
 *
 * **The note is what an app has always drawn, so its sentence has to stand on
 * its own.** An app that has never heard of `failure` draws the text and
 * nothing else, so the text says what happened and to which model; what can be
 * done about it rides in `data`, where an app that knows offers it as a
 * doorway (`POST …/chat/:id/retry`).
 *
 * It used to be the provider's own error relayed — an HTTP status with a JSON
 * body glued to it for an account problem, and "Something went wrong talking
 * to the model:" in front of anything else — which told somebody whose OpenAI
 * account had run out of credit nothing they could act on, in a home that had
 * a perfectly good Anthropic key beside it.
 */

/**
 * What went wrong, as a word an app can branch on. **Open**, the
 * `commandFailed.kind` rule: an app that meets one it has never seen still has
 * the sentence. The classifier's seven, and three of this file's own:
 * `refused` (the model declined), `unavailable` (the model asked for cannot be
 * run here right now) and `failed` (anything the classifier did not
 * recognise, in the provider's own words).
 */
export type ChatFailureKind = AiFailureKind | 'refused' | 'unavailable' | 'failed';

/** `data.failure` on a note. */
export interface ChatFailureWire {
  /** Whose model failed — `anthropic` or `openai`, and open. */
  provider: string;
  /** The model that failed, by id. */
  model: string;
  kind: ChatFailureKind;
  /**
   * The same model may well answer if it is simply asked again — a busy
   * vendor, a dropped connection, a round that ran out of time. Absent where
   * asking again would meet the same answer: no credit, a refused key, a
   * declined question.
   */
  transient?: true;
  /**
   * The person's message the failed round was answering, by row id.
   *
   * **Said rather than inferred.** A message sent while a round is running is
   * written the moment it is taken, so it lands *ahead* of that round's note:
   * "the newest message before the note" is then the message queued behind,
   * not the one that failed, and asking it again answered the wrong one twice.
   * It is also what a recap leaves out when the round was declined.
   */
  messageId?: string;
}

/** `data.switchTo` on a note: the other vendor's model on the failed one's tier, offered by name. */
export interface ChatSwitchWire {
  model: string;
  /** What a person sees — the hub's own label, as the model lists carry it. */
  label: string;
  provider: AiProvider;
}

/** A note's whole payload, when the round behind it can be answered again. */
export interface ChatFailureNote {
  text: string;
  data: { failure: ChatFailureWire; switchTo?: ChatSwitchWire };
}

const VENDOR: Readonly<Record<string, string>> = { anthropic: 'Anthropic', openai: 'OpenAI' };

const TRANSIENT: ReadonlySet<ChatFailureKind> = new Set(['rate_limited', 'overloaded', 'network', 'aborted']);

/** A sentence's last character, made a full stop where it is not one already. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * The note for a round that threw.
 *
 * **Named after the model, not the hub or "the model"**: since a chat can pick
 * its model from either vendor, "the model" no longer says which of two
 * failed, and which vendor's account to look at is the whole of the fix.
 */
export function failureSentence(
  provider: string,
  model: string,
  error: unknown,
): { text: string; kind: ChatFailureKind } {
  const label = modelLabel(provider, model);
  const vendor = VENDOR[provider] ?? provider;
  if (!(error instanceof AiUnavailableError)) {
    return { kind: 'failed', text: sentence(`${label} couldn’t answer: ${readableFailure(error)}`) };
  }
  if (error.kind === 'aborted') {
    return { kind: 'aborted', text: `${label} took too long to answer, so your hub stopped waiting.` };
  }
  return { kind: error.kind, text: `${label} couldn’t answer: ${accountReason(error.kind, vendor)}` };
}

/**
 * Why a vendor said no, as the end of a sentence — "this home’s OpenAI account
 * is out of credit." — for every kind but `aborted`, which is the hub's own
 * watchdog rather than anything the vendor said.
 *
 * **One set of words for every surface a vendor can refuse**: a chat's note
 * and the voice's refusal (`voiceFailure`) say the same thing about the same
 * account, so the person reading either is sent to the same place.
 */
function accountReason(kind: Exclude<AiFailureKind, 'aborted'>, vendor: string): string {
  switch (kind) {
    case 'billing':
      return `this home’s ${vendor} account is out of credit.`;
    case 'usage_limit':
      return `this home’s ${vendor} account has reached its usage limit.`;
    case 'rate_limited':
      return `${vendor} is limiting how fast this home’s key can be used. Try again in a minute.`;
    case 'auth_failed':
      return `${vendor} didn’t accept this home’s key.`;
    case 'overloaded':
      return `${vendor} is overloaded right now.`;
    case 'network':
      return `your hub couldn’t reach ${vendor}.`;
  }
}

/** `failure` on a `502 voice_unavailable`: the chat note's own fields, less the model. */
export interface VoiceFailureWire {
  /** Always `openai` today — GPT-Live is the only voice — and open. */
  provider: string;
  kind: ChatFailureKind;
  transient?: true;
}

/**
 * A voice session OpenAI would not open, said the way a failed chat round is.
 *
 * **It used to be OpenAI's own sentence relayed**, which on an account with no
 * credit left was "You have no credits remaining. Add credits to continue
 * using the API at https://platform.openai.com/settings/organization/billing/."
 * — a URL cut off mid-word on a phone, about an account the person may not
 * hold, beside a chat note on the same page that said the same thing as
 * "this home’s OpenAI account is out of credit." Same taxonomy, same words, so
 * the two never disagree about one account.
 *
 * `kind` and `transient` ride beside the sentence for an app that can offer a
 * way out by them; an app that has never heard of them draws `detail`, which
 * stands on its own. An unrecognised refusal keeps OpenAI's words, since an
 * invented reason would be worse than theirs.
 */
export function voiceFailure(error: unknown): { text: string; failure: VoiceFailureWire } {
  const provider = 'openai';
  const vendor = VENDOR[provider] ?? provider;
  const lead = 'The voice couldn’t start';
  if (!(error instanceof AiUnavailableError)) {
    return {
      text: sentence(`${lead}: ${readableFailure(error)}`),
      failure: { provider, kind: 'failed' },
    };
  }
  const text =
    error.kind === 'aborted'
      ? `${vendor} took too long to answer, so your hub stopped waiting.`
      : `${lead}: ${accountReason(error.kind, vendor)}`;
  return {
    text,
    failure: {
      provider,
      kind: error.kind,
      ...(TRANSIENT.has(error.kind) ? { transient: true as const } : {}),
    },
  };
}

/**
 * The other vendor's model on the tier the failed one was on, when this home
 * can run it.
 *
 * **Always the other vendor**, never another model of the same one: a billing,
 * key or capacity problem is the vendor's, so a cheaper model on the same
 * account meets it too — and a refusal is the one case a different vendor's
 * model may genuinely answer differently.
 *
 * **And the same tier** (`agentCounterpart`), because somebody who put a chat
 * on the quicker, cheaper model chose the tier as much as the vendor, and the
 * button that answers for it must not quietly spend four times as much — nor
 * answer a question sent to the most capable model with the other vendor's
 * everyday one. GPT-6.1 Terra is answered again by
 * Sonnet 5.5, Haiku 5.5 by GPT-6 Luna, Opus 5.5 by GPT-6.1 Sol. It was the
 * other vendor's default whatever had failed, which offered Opus 5.5 to a chat
 * on Terra.
 */
export function switchOffer(provider: string, model: string, usable: UsableProviders): ChatSwitchWire | undefined {
  const other: AiProvider | undefined =
    provider === 'anthropic' ? 'openai' : provider === 'openai' ? 'anthropic' : undefined;
  if (other === undefined || !usable[other]) return undefined;
  const offered = agentCounterpart(model, other);
  return { model: offered, label: modelLabel(other, offered), provider: other };
}

/** A failure note's payload: what failed, and the other vendor's model on its tier if it can answer. */
export function failureNote(
  provider: string,
  model: string,
  kind: ChatFailureKind,
  text: string,
  usable: UsableProviders | undefined,
  /** The person's message the failed round was answering — see `messageId`. */
  messageId?: string,
): ChatFailureNote {
  const offer = usable === undefined ? undefined : switchOffer(provider, model, usable);
  return {
    text,
    data: {
      failure: {
        provider,
        model,
        kind,
        ...(TRANSIENT.has(kind) ? { transient: true as const } : {}),
        ...(messageId !== undefined ? { messageId } : {}),
      },
      ...(offer !== undefined ? { switchTo: offer } : {}),
    },
  };
}

/** Whether a stored note is one a round can be asked again from. */
export function isRetryableNote(row: { role: string; data?: unknown }): boolean {
  if (row.role !== 'note') return false;
  const failure = (row.data as { failure?: unknown } | null | undefined)?.failure;
  return typeof failure === 'object' && failure !== null;
}

/** The message a stored failure note says its round was answering, if it says. */
export function failedMessageId(row: { data?: unknown }): string | undefined {
  const id = (row.data as { failure?: { messageId?: unknown } } | null | undefined)?.failure?.messageId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * The ids a recap leaves out because a model declined them: each declined
 * message, and the note its refusal was written as.
 *
 * **Every recap, not only the one straight after the refusal.** A message a
 * Claude declined is read again by the next one it is put in front of — the
 * classifier that declined it declines what follows it — and a conversation is
 * rebuilt from its record whenever it moves model, lets a photo go or wakes
 * after a restart. A refusal somebody has since asked again (`retried`) is
 * left in: that message has been answered, and leaving it out would leave its
 * answer replying to nothing.
 */
export function declinedRows(rows: readonly { id: string; role: string; data?: unknown }[]): Set<string> {
  const left = new Set<string>();
  for (const row of rows) {
    if (row.role !== 'note' || !isRetryableNote(row)) continue;
    const data = row.data as { failure?: { kind?: unknown }; retried?: unknown } | null | undefined;
    if (data?.failure?.kind !== 'refused' || data.retried !== undefined) continue;
    const message = failedMessageId(row);
    if (message === undefined) continue;
    left.add(message);
    left.add(row.id);
  }
  return left;
}
