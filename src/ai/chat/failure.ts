import type { AiProvider } from '../../core/settings.js';
import { AiUnavailableError, readableFailure, type AiFailureKind } from '../errors.js';
import { AGENT_MODELS, modelLabel, type UsableProviders } from '../models.js';

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
}

/** `data.switchTo` on a note: the other vendor's model, offered by name. */
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
  switch (error.kind) {
    case 'billing':
      return { kind: 'billing', text: `${label} couldn’t answer: this home’s ${vendor} account is out of credit.` };
    case 'usage_limit':
      return {
        kind: 'usage_limit',
        text: `${label} couldn’t answer: this home’s ${vendor} account has reached its usage limit.`,
      };
    case 'rate_limited':
      return {
        kind: 'rate_limited',
        text: `${label} couldn’t answer: ${vendor} is limiting how fast this home’s key can be used. Try again in a minute.`,
      };
    case 'auth_failed':
      return { kind: 'auth_failed', text: `${label} couldn’t answer: ${vendor} didn’t accept this home’s key.` };
    case 'overloaded':
      return { kind: 'overloaded', text: `${label} couldn’t answer: ${vendor} is overloaded right now.` };
    case 'network':
      return { kind: 'network', text: `${label} couldn’t answer: your hub couldn’t reach ${vendor}.` };
    case 'aborted':
      return { kind: 'aborted', text: `${label} took too long to answer, so your hub stopped waiting.` };
  }
}

/**
 * The other vendor's model, when this home can run it.
 *
 * **Always the other vendor**, never another model of the same one: a billing,
 * key or capacity problem is the vendor's, so a cheaper model on the same
 * account meets it too — and a refusal is the one case a different vendor's
 * model may genuinely answer differently. Its default, because the offer is
 * one button rather than a list, and that vendor's recommended model is the
 * one this hub would have chosen for a home that had only that key.
 */
export function switchOffer(provider: string, usable: UsableProviders): ChatSwitchWire | undefined {
  const other: AiProvider | undefined =
    provider === 'anthropic' ? 'openai' : provider === 'openai' ? 'anthropic' : undefined;
  if (other === undefined || !usable[other]) return undefined;
  const model = AGENT_MODELS[other].default;
  return { model, label: modelLabel(other, model), provider: other };
}

/** A failure note's payload: what failed, and the other vendor if it can answer. */
export function failureNote(
  provider: string,
  model: string,
  kind: ChatFailureKind,
  text: string,
  usable: UsableProviders | undefined,
): ChatFailureNote {
  const offer = usable === undefined ? undefined : switchOffer(provider, usable);
  return {
    text,
    data: {
      failure: { provider, model, kind, ...(TRANSIENT.has(kind) ? { transient: true as const } : {}) },
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
