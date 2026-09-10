import type { AiProvider } from '../core/settings.js';
import type { AiRunKind } from '../core/ai-runs.js';
import type { AutomationEngine } from '../automations/engine.js';
import type { AutomationStore } from '../automations/store.js';
import { automationDocumentSchema, type AutomationDocument } from '../automations/schema.js';
import { automationShape, describeAutomation } from '../automations/summarize.js';
import { effectiveAgentModel } from './models.js';
import type { AutomationConversation, AutomationTurn } from './automation-conversation.js';
import {
  AgentNotConfiguredError,
  ChatRuntime,
  type AgentSurface,
  type ChatMessageWire,
  type ChatRuntimeOptions,
  type ChatSession,
} from './chat/chat-runtime.js';

/**
 * The conversation in which a rule gets written.
 *
 * **Almost all of this used to live here and is now one floor down.** Sessions
 * with a lifetime, a memory rebuilt from the transcript, the four socket
 * phases, the spend ledger, the conversations list — none of that is about
 * automations, and the assistant needs every bit of it. `ChatRuntime` holds
 * it; what is left here is the part that genuinely is this agent's: which
 * model and prompt open a conversation, and what happens when it hands a rule
 * back.
 *
 * **A conversation costs nothing until somebody starts one.** No client, no
 * prompt, no import of the vendor SDK — `openConversation` loads whichever
 * half it needs on the first message, which is the `lazy.ts` seam applied one
 * module over.
 */

// The wire vocabulary is the runtime's, and is re-exported here because both
// apps and the routes have always imported it from this module.
export {
  AgentNotConfiguredError as AutomationNotConfiguredError,
  type ChatMessageWire,
  type ChatReply,
  type ChatSpendWire,
  type ChatStepWire,
  type ChatSummaryWire,
} from './chat/chat-runtime.js';

export interface AutomationChatOptions extends ChatRuntimeOptions {
  engine: AutomationEngine;
  store: AutomationStore;
  /** Overridden in tests, so the suite never reaches a provider. */
  createConversation?: (input: {
    modelId: string;
    secret: string;
    systemPrompt: string;
    taskPrompt: string;
  }) => AutomationConversation;
}

export class AutomationChat extends ChatRuntime<AutomationTurn> {
  protected readonly surface: AgentSurface = 'automation';
  protected readonly eventName = 'automationChat' as const;
  protected readonly runKind: AiRunKind = 'automate';
  protected readonly runAdapter = 'automations';

  constructor(private readonly options: AutomationChatOptions) {
    super(options);
  }

  /** Start a conversation, optionally about a rule that already exists. */
  override async start(input: {
    memberId: string;
    message: string;
    automationId?: string | undefined;
  }): Promise<import('./chat/chat-runtime.js').ChatReply> {
    return super.start({
      memberId: input.memberId,
      message: input.message,
      ...(input.automationId !== undefined ? { topic: input.automationId } : {}),
    });
  }

  /**
   * The rule a revived conversation was about, recovered from the transcript
   * rather than remembered: a preview row carries the id, and an edit
   * conversation that produced one is still an edit conversation.
   */
  protected override topicFromRows(rows: ChatMessageWire[]): string | undefined {
    return rows
      .map((row) => (row.data as { automationId?: string } | undefined)?.automationId)
      .filter((id): id is string => typeof id === 'string')
      .at(-1);
  }

  /** The rules this conversation handed back. Everything else is shared. */
  protected async recordAgentTurn(
    session: ChatSession<AutomationTurn>,
    turn: AutomationTurn,
  ): Promise<ChatMessageWire[]> {
    if (turn.kind !== 'submitted') return [];
    /**
     * **One reply, one line, and a card per rule.** The prose comes first
     * because it is the answer to what was asked; each rule follows as its
     * own row, so an app draws one card per rule with its own switch and
     * has nothing to unpack.
     */
    const messages: ChatMessageWire[] = [];
    const saved: { id: string; document: AutomationDocument; edited: boolean }[] = [];
    for (const rule of turn.rules) {
      const parsed = automationDocumentSchema.safeParse(rule.document);
      if (!parsed.success) {
        // The loop already validated this, so reaching here means the two
        // disagree — worth saying rather than writing a broken preview.
        messages.push(
          await this.write(session, 'note', 'One of those rules could not be saved.'),
        );
        continue;
      }
      saved.push(await this.save(session, parsed.data, rule.replaces));
      session.produced += 1;
    }
    if (saved.length === 0) return messages;
    // A conversation that produced a rule has done its job; recording the
    // spend now means an abandoned tab does not delay the row for hours.
    await this.record(session, true);
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
     * was, at that moment, switched on. `edited` is per rule too — one
     * reply can change one rule and add another.
     */
    for (const rule of saved) {
      const record = this.options.engine.get(rule.id);
      messages.push(
        await this.write(
          session,
          'preview',
          describeAutomation(rule.document, this.options.engine.homeView()),
          {
            automationId: rule.id,
            name: rule.document.name,
            shape: automationShape(rule.document),
            enabled: record?.enabled ?? false,
            edited: rule.edited,
          },
        ),
      );
    }
    return messages;
  }

  /**
   * Write the rule down — created **switched off**, or applied as an edit.
   *
   * An edit takes effect on a rule the person already chose to have running,
   * which is why it is versioned: `POST /automations/:id/revert` is the way
   * back, and the version note says the chat did it.
   *
   * **Which of the two it is comes from the model, not from this session.**
   * It used to be positional: the first submission created a rule, the
   * conversation remembered it, and every submission after that *replaced* it.
   * That was right about one case — the model fixing the rule it had just
   * written — and silently wrong about the other, which is a conversation that
   * produces two rules: "and also switch everything off at midnight"
   * overwrote what had been written a minute earlier, so a chat could only
   * ever leave one rule behind. Nothing here can tell the two apart; the model
   * can, and `replaces` is where it says so.
   *
   * A `replaces` naming a rule that is gone (deleted from another phone while
   * the conversation was open) falls back to creating one, which is what the
   * person asked for and what the card will then say.
   */
  private async save(
    session: ChatSession<AutomationTurn>,
    document: AutomationDocument,
    replaces: string | null,
  ): Promise<{ id: string; document: AutomationDocument; edited: boolean }> {
    if (replaces !== null && this.options.engine.get(replaces)) {
      await this.options.store.update(replaces, document, session.memberId, 'edited in chat');
      await this.options.engine.reload();
      this.options.events.emit('automationChanged', replaces);
      this.rememberSaved(session, replaces, document.name);
      return { id: replaces, document, edited: true };
    }
    const record = await this.options.store.create(document, session.memberId, 'written in chat');
    await this.options.engine.reload();
    this.options.events.emit('automationChanged', record.id);
    // What the `ai_runs` row records as what the spend bought. The *first*
    // rule a conversation writes, since the column holds one id and a chat can
    // now leave several behind; it no longer decides anything about editing.
    session.topic ??= record.id;
    this.rememberSaved(session, record.id, document.name);
    return { id: record.id, document, edited: false };
  }

  /**
   * Tell the model, on its next turn, what the rule it just wrote is called.
   *
   * **Without this a conversation cannot revise its own work.** `replaces`
   * needs an id, and a rule the model wrote a minute ago has one the model has
   * never seen: the ids it knows are the ones listed in the first user
   * message, from before this conversation wrote anything. So the id rides on
   * `ChatSession.priming`, the channel `revive()` already uses to hand the
   * model context that belongs to it rather than to the transcript — it
   * reaches the model and is never written down as a message, because it is a
   * fact about the conversation rather than something anybody said.
   */
  private rememberSaved(session: ChatSession<AutomationTurn>, id: string, name: string): void {
    const line = `The rule "${name}" is saved with id ${id}. To change that same rule later, submit with replaces set to "${id}"; to add a different rule, submit with replaces null.`;
    session.priming = session.priming === undefined ? line : `${session.priming}\n${line}`;
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
  protected async openConversation(input: {
    memberId: string;
    topic: string | undefined;
    sessionId: string;
  }): Promise<AutomationConversation> {
    const automationId = input.topic;
    const ai = await this.options.settings.getAiSettings();
    if (!ai.enabled) throw new AgentNotConfiguredError('ai_disabled');
    if (!ai.hasKey) throw new AgentNotConfiguredError('ai_not_configured');

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
    if (!secret) throw new AgentNotConfiguredError('ai_not_configured');

    /**
     * **This agent's own model, and it did not have one.**
     *
     * It read `ai[provider].model` — the *mapper's* column, through the
     * mapper's list — so "which model recognises a device" and "which model
     * writes a rule" shared an answer. It never showed, because the mapper
     * offers one model and Sonnet is not on its list, so `effectiveModel`
     * handed back Opus whatever was stored. Now it reads its own column
     * through `AGENT_MODELS`, which is the same two models the assistant is
     * offered and a choice made separately: answering questions about the
     * house and writing the rules it runs by itself are different jobs, and a
     * home may want to spend differently on them.
     *
     * `effectiveAgentModel`, never the stored column — the one bug that cost
     * the mapper a release: every surface that *reported* a model went through
     * it while the call that picked one to run read the column.
     */
    const modelId = effectiveAgentModel(ai.automations.model);

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
      throw new AgentNotConfiguredError(
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

}
