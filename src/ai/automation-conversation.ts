import type { AskUser } from './automation-tools.js';

/**
 * Everything about an automation conversation that is not one vendor's API.
 *
 * The `agent-core.ts` split, kept for the same load-bearing reason: a home
 * configured with only an OpenAI key must never load the Anthropic SDK to
 * satisfy an import chain, so the seam, the guardrails and the vocabulary live
 * here and each vendor's loop is imported on demand.
 *
 * **The shape of a conversation is what makes this different from the mapping
 * agent**, which is one call that either produces a descriptor or does not.
 * Here the loop *suspends* — twice over, and for two different reasons — and
 * both suspensions have to survive the HTTP request they started in:
 *
 *  - the model calls `ask_user`, and nothing more can happen until a person
 *    answers;
 *  - the model stops with prose, which is the model's way of saying "over to
 *    you" and is a perfectly good outcome for a chat.
 *
 * So a conversation is an object that outlives a request, and the provider —
 * not the caller — owns the message history, because that history is the
 * vendor's own shape (thinking blocks, tool-use ids, cache breakpoints) and
 * nothing outside the loop should be holding it.
 */

/** Provider rounds one *user message* may cost. A person is waiting. */
export const AUTOMATION_MAX_TURNS = 12;

/**
 * What one conversation may spend, in total.
 *
 * On the conversation rather than on a turn, which is the difference from the
 * mapping agent's per-run cap: twenty rounds of clarification are twenty
 * requests, and a ceiling that resets on every message is not a ceiling.
 */
export const AUTOMATION_MAX_BUDGET_USD = 1;

/**
 * One turn's wall clock.
 *
 * Three minutes, not the mapper's ten. Nobody watches a device being
 * recognised; somebody is sitting in front of this, and a chat that has been
 * silent for three minutes has failed whatever the model is doing.
 */
export const AUTOMATION_TIMEOUT_MS = 3 * 60_000;

/** How long an idle conversation is kept before its history is dropped. */
export const AUTOMATION_SESSION_TTL_MS = 2 * 60 * 60_000;

/** Conversations held at once, hub-wide. */
export const AUTOMATION_MAX_SESSIONS = 8;

/**
 * What a turn ended with.
 *
 * `said` and `question` are both suspensions and both perfectly ordinary;
 * `submitted` is the answer; `stopped` is a turn that ran out of rounds,
 * budget or time, and carries the sentence a person should read.
 */
/**
 * One rule the model handed over, already validated.
 *
 * `replaces` is the id of the rule it is a new version of, or `null` for a new
 * one — the model says which on every submission, because nothing else can
 * tell "here is that rule again, fixed" from "here is a second rule".
 */
export interface SubmittedRule {
  document: unknown;
  note?: string | undefined;
  replaces: string | null;
}

export type AutomationTurn =
  | { kind: 'question'; question: AskUser }
  | {
      kind: 'submitted';
      /**
       * **A list, because one reply can carry more than one rule.** "Lights on
       * when I come in and off when I leave" is two rules — the prompt has said
       * so since the day it shipped — and the loop used to keep a single
       * `handedBack`, so the second submission in a response overwrote the
       * first and one of the two was silently dropped between being accepted
       * and being saved. Each becomes its own card.
       */
      rules: SubmittedRule[];
      /** What the model said alongside them, when it said anything. */
      text: string;
    }
  | { kind: 'said'; text: string }
  | { kind: 'stopped'; reason: string };

/** The accepted-rules arm on its own, for the loop that holds one back while it
 *  asks the model for the sentence that goes above the cards. */
export type SubmittedTurn = Extract<AutomationTurn, { kind: 'submitted' }>;

/** What a running turn reports as it happens, for the socket. */
export interface AutomationTurnContext {
  /** Text as it arrives, so a chat is not three minutes of nothing. */
  onDelta?: (text: string) => void;
  /**
   * The model's own summarized reasoning, as it arrives.
   *
   * **This is what fills the longest silence in a round.** A step is reported
   * when something has *happened*, and the first thing that happens in a round
   * is tens of seconds of the model reading the home and deciding — before a
   * tool has been called or a word of the reply written. Without this the
   * whole of that is a spinner.
   *
   * Only useful because the loop asks for `display: 'summarized'`; with the
   * default the thinking blocks stream empty and this never fires.
   */
  onThinking?: (text: string) => void;
  /**
   * One line per notable thing the turn did — a tool call, a submission.
   *
   * `kind` is what an app draws a mark from without reading the sentence, and
   * is an open string: a client that meets a new one falls back and still
   * shows the words.
   */
  onStep?: (summary: string, kind: AutomationStepKind, detail?: string) => void;
}

/**
 * What a step *is*, in the vocabulary an app draws marks from.
 *
 * Deliberately about the shape of the act rather than the tool that did it:
 * three different tools all mean "the agent is reading your home", and an app
 * that had to map seven tool names would need updating every time the agent
 * learns an eighth.
 */
export type AutomationStepKind =
  | 'thinking'
  | 'reading'
  | 'checking'
  | 'writing'
  | 'asking';

/**
 * One conversation, owned by whichever vendor's loop is running it.
 *
 * `send` and `answer` are two entry points rather than one because the second
 * has to close a tool call the model is waiting on: an answer to `ask_user`
 * goes back as a `tool_result` for that call's id, and a plain user message
 * after a pending tool call is a conversation the API will refuse.
 */
export interface AutomationConversation {
  send(text: string, context?: AutomationTurnContext): Promise<AutomationTurn>;
  answer(text: string, context?: AutomationTurnContext): Promise<AutomationTurn>;
  /** True while a `ask_user` is outstanding. */
  awaitingAnswer(): boolean;
  costUsd(): number;
  /** Which model has been answering, for the run log and for the apps. */
  readonly modelId: string;
  readonly provider: string;
}
