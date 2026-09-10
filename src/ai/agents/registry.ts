import type { PermissionKey } from '../../core/access.js';
import type { AutomationChat } from '../automation-chat.js';

/**
 * The agents the assistant can hand a job to.
 *
 * **A table rather than an `if`, and that is the whole point of it.** There is
 * one entry today. There will be more, and the shape of "more" decides how
 * much each one costs to add: with a tool per agent, a third means a new tool,
 * a new paragraph in the system prompt naming it, and a release of both apps
 * before anybody can reach it. With one `delegate` tool whose description is
 * *generated* from this table, a third agent is one entry — the model is told
 * about it in the same breath it is told about the others, and no app changes
 * at all.
 *
 * Two rules an entry has to keep.
 *
 * **`description` is written for the model, and it is the only thing the model
 * knows about that agent.** It says what the agent is for and, where it
 * matters, what it is *not* for — because the failure this prevents is the
 * assistant handing a job to the wrong agent and the person watching a rule
 * being written when they asked a question.
 *
 * **`permission` is checked when the tool runs, not when the prompt is
 * built.** A guest gets a refusal sentence the model can read out, rather than
 * a feature that is silently absent for reasons nobody explains: the
 * `RoleNotice` rule, applied to an agent.
 */
export interface DelegateAgent {
  /** What the model writes in `delegate`'s `agent` field. */
  key: string;
  /** What a person calls it, for the card the app draws. */
  title: string;
  /** What it is for, and what it is not. Goes into the tool description. */
  description: string;
  /** What a member needs to hand it a job. */
  permission: PermissionKey;
  /**
   * Start it on a brief, and answer as soon as it has taken the message.
   *
   * Never awaits the other agent's turn — that is the whole contract, and the
   * `POST /devices/:id/remap` lesson this repository has now paid for twice.
   */
  start(input: { memberId: string; brief: string }): Promise<{ sessionId: string }>;
  /**
   * Say something else to a job it already has, and answer as soon as that is
   * taken too.
   *
   * **A follow-up belongs to the conversation that did the work**, which is
   * the whole of why this exists: every handover used to open a fresh one, so
   * "now make it 11:30 instead" reached an agent that had never heard of the
   * rule it had written five seconds earlier, and paid to read the home again
   * to find out. Answers `false` for a session it can no longer carry on —
   * past the fortnight, or never there — so the caller can fall back to a
   * fresh one rather than failing.
   */
  resume(input: { memberId: string; sessionId: string; brief: string }): Promise<boolean>;
}

export function delegateAgents(deps: { automationChat: AutomationChat }): DelegateAgent[] {
  return [
    {
      key: 'automations',
      title: 'Automations agent',
      description:
        'Writes and changes the rules this home runs by itself — schedules, "when the sensor ' +
        'sees somebody", and the scenes somebody can press. Hand it anything that should keep ' +
        'happening without being asked, and anything that changes what an existing rule does. ' +
        'It knows the rule format and checks a draft against the guards that protect the ' +
        'devices, neither of which you can see. Not for switching something on now, and not ' +
        'for questions about a rule — you can read and press those yourself.',
      permission: 'automation.manage',
      async start(input) {
        const reply = await deps.automationChat.start({
          memberId: input.memberId,
          message: input.brief,
        });
        return { sessionId: reply.sessionId };
      },
      async resume(input) {
        // `reply` revives from the transcript where the memory has gone, so
        // "can it be carried on" is a question only it can answer — null is
        // the conversation with no rows at all.
        const reply = await deps.automationChat.reply(
          input.sessionId,
          input.memberId,
          input.brief,
        );
        return reply !== null;
      },
    },
  ];
}
