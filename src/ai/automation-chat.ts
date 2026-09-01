import { randomUUID } from 'node:crypto';
import { asc, eq, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { automationChatMessages } from '../db/schema.js';
import type { HubEventBus } from '../core/bus.js';
import type { SettingsService } from '../core/settings.js';
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
  /** Whether this conversation's spend has been written down yet. */
  recorded: boolean;
  submissions: number;
}

export interface ChatMessageWire {
  id: string;
  at: string;
  role: 'user' | 'agent' | 'question' | 'preview' | 'note';
  text: string;
  data?: unknown;
}

export interface ChatReply {
  sessionId: string;
  /** What the agent did with this message. */
  turn: AutomationTurn;
  /** The message rows this exchange produced, in order. */
  messages: ChatMessageWire[];
}

export class AutomationNotConfiguredError extends Error {
  constructor(readonly code: 'ai_not_configured' | 'ai_disabled') {
    super(code);
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

    const conversation = await this.resolveConversation(input.automationId);
    const session: ChatSession = {
      id: randomUUID(),
      memberId: input.memberId,
      conversation,
      lastAt: Date.now(),
      recorded: false,
      submissions: 0,
      ...(input.automationId !== undefined ? { automationId: input.automationId } : {}),
    };
    this.sessions.set(session.id, session);
    return this.exchange(session, input.message, 'send');
  }

  /** Continue one. A typed reply to a question is an answer, not a new
   *  message — the conversation itself decides which, since only it knows
   *  whether a tool call is outstanding. */
  async reply(sessionId: string, memberId: string, text: string): Promise<ChatReply | null> {
    const session = this.sessions.get(sessionId);
    if (!session || session.memberId !== memberId) return null;
    return this.exchange(session, text, session.conversation.awaitingAnswer() ? 'answer' : 'send');
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

  /** Whether this conversation can still be continued, or is history. */
  isLive(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    await this.record(session, session.submissions > 0);
  }

  // ── One exchange ───────────────────────────────────────────────────────────

  private async exchange(
    session: ChatSession,
    text: string,
    how: 'send' | 'answer',
  ): Promise<ChatReply> {
    const written: ChatMessageWire[] = [];
    written.push(await this.write(session, 'user', text, undefined, session.memberId));

    let turn: AutomationTurn;
    try {
      turn = await session.conversation[how](text, {
        onStep: (summary, detail) => {
          this.options.events.emit('automationChat', {
            sessionId: session.id,
            phase: 'step',
            at: new Date().toISOString(),
            text: summary,
            ...(detail !== undefined ? { detail } : {}),
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
      written.push(await this.write(session, 'note', message));
      session.lastAt = Date.now();
      return { sessionId: session.id, turn: { kind: 'stopped', reason: message }, messages: written };
    }

    session.lastAt = Date.now();
    written.push(...(await this.recordTurn(session, turn)));

    this.options.events.emit('automationChat', {
      sessionId: session.id,
      phase: 'turn',
      at: new Date().toISOString(),
      text: turn.kind,
    });

    return { sessionId: session.id, turn, messages: written };
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
    const provider = ai.provider;
    if (!provider || !ai.hasKey) throw new AutomationNotConfiguredError('ai_not_configured');
    if (provider === 'anthropic' && ai.legacySubscriptionToken) {
      throw new AutomationNotConfiguredError('ai_not_configured');
    }
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

    if (this.options.createConversation) {
      return this.options.createConversation({ modelId, secret, systemPrompt, taskPrompt });
    }
    if (provider === 'openai') {
      // The OpenAI half of this agent is not written yet, and saying so beats
      // a 500 or a silent fall back to a provider the home did not choose.
      throw new AiUnavailableError(
        'auth_failed',
        'Writing automations needs an Anthropic key at the moment. Add one in the home’s AI ' +
          'settings, or switch which provider this home uses.',
      );
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
    });
    await handle.finish({
      ok,
      costUsd: session.conversation.costUsd(),
      durationMs: Date.now() - session.lastAt,
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
