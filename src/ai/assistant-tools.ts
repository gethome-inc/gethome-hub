import { z } from 'zod';
import type { EndpointState, HubCommand } from '../schema/index.js';
import { commandSchema } from '../schema/wire.js';
import type { AutomationHomeView } from '../automations/targets.js';
import { automationShape } from '../automations/summarize.js';
import {
  askUserInput,
  runAutomationTool,
  toolStep,
  type AutomationToolDefinition,
  type AutomationToolResult,
} from './automation-tools.js';

/**
 * What the assistant can do, which is deliberately a short list.
 *
 * Three of these are the automations agent's own read tools, called through
 * its handler rather than re-implemented: they are pure functions over a home
 * view, and two answers to "what devices are there" is two answers to drift.
 *
 * What is new here is the pair the automations agent must never have — one
 * that *works* the home, and one that hands a job to another agent — plus
 * `ask_user`, which is shared verbatim so a question the assistant asks draws
 * with the same tappable options a rule-writing question does.
 *
 * There is no web search, for the reason the automations agent has none: an
 * assistant for one house has nothing to look up, and leaving it out is a
 * plainer promise than a paragraph asking the model not to search.
 */

export interface DelegateOutcome {
  /** The conversation the other agent is now having. */
  sessionId: string;
  /** What to tell the model, which is not what to tell the person. */
  text: string;
  /** Why it could not be handed over, when it could not. */
  refused?: string;
}

export interface AssistantToolContext {
  home: () => AutomationHomeView;
  timezone: () => string;
  /** Current state, for the one device that turns out to matter. */
  stateOf: (deviceId: string, endpointId: number) => EndpointState | undefined;
  /**
   * Work a device. Resolves when the hub has taken the command, which is not
   * the same as the device having done it — see the `commandFailed` frame.
   */
  control: (deviceId: string, endpointId: number, command: HubCommand) => Promise<void>;
  /** Press a rule somebody could press, or switch a mode the other way. */
  runAutomation: (id: string) => Promise<boolean>;
  /** Hand a whole job to another agent. */
  delegate: (agent: string, brief: string) => Promise<DelegateOutcome>;
  /** The agents that can be handed a job, for the tool's own description. */
  delegates: readonly { key: string; title: string; description: string }[];
}

/**
 * How many devices one turn may command.
 *
 * Not a guard against a person — a person tapping quickly is a person, which
 * is the whole reason the automations engine's limits can be as tight as they
 * are. This is a guard against a *misread*: "turn everything off" understood
 * as the whole house when it meant the kitchen is a model's mistake landing on
 * forty relays at once. Eight covers every real request and stops that one.
 */
export const ASSISTANT_MAX_COMMANDS_PER_TURN = 8;

// ── Schemas ──────────────────────────────────────────────────────────────────

const controlDeviceInput = z
  .object({
    deviceId: z.string(),
    /** Which endpoint, for a device that has more than one. Defaults to the
     *  first, which is what a single-gang anything has. */
    endpointId: z.number().int().min(0).optional(),
    command: commandSchema,
  })
  .strict();

const runAutomationInput = z.object({ automationId: z.string() }).strict();

const delegateInput = z
  .object({
    agent: z.string().min(1).max(60),
    /**
     * The whole task, in one self-contained message.
     *
     * **This is the interface between the two agents**, and it is prose rather
     * than a structure on purpose: the other agent is a conversation, and what
     * it needs is what a person would have typed into it. It is also the only
     * thing that crosses, which is what keeps this agent's context free of the
     * other one's tool calls.
     */
    brief: z.string().min(1).max(1_500),
  })
  .strict();

function json(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  delete generated.$schema;
  return generated;
}

// ── The tools ────────────────────────────────────────────────────────────────

/** The step each tool shows, in the words a person reads. */
const ASSISTANT_TOOL_STEPS: Readonly<Record<string, { summary: string; kind: string }>> = {
  control_device: { summary: 'Working a device', kind: 'writing' },
  run_automation: { summary: 'Running one of your scenes', kind: 'writing' },
  list_automations: { summary: 'Looking at what your home does by itself', kind: 'reading' },
  delegate: { summary: 'Handing this to another agent', kind: 'writing' },
};

export function assistantToolStep(name: string): { summary: string; kind: string } {
  return ASSISTANT_TOOL_STEPS[name] ?? toolStep(name);
}

export function assistantTools(
  delegates: readonly { key: string; title: string; description: string }[],
): AutomationToolDefinition[] {
  return [
    {
      name: 'list_devices',
      description:
        'Every device in the home, optionally narrowed to a room or to devices with a given ' +
        'capability. The first message already carries this list; call it again to filter, or ' +
        'after something has changed.',
      schema: () =>
        json(z.object({ roomId: z.string().optional(), capability: z.string().optional() }).strict()),
    },
    {
      name: 'get_device',
      description:
        'One device in full: its endpoints, what each can do, what it is reporting right now, ' +
        'and any settings it exposes. Use it before working a device whose exact endpoint or ' +
        'current value matters.',
      schema: () => json(z.object({ deviceId: z.string() }).strict()),
    },
    {
      name: 'list_rooms_zones',
      description: 'The rooms and zones of this home, with their ids.',
      schema: () => ({ type: 'object', additionalProperties: false, properties: {} }),
    },
    {
      name: 'list_automations',
      description:
        'What this home does by itself: every rule, whether it is switched on, and which ones ' +
        'are pressable (a button or a mode) as against watching for something.',
      schema: () => ({ type: 'object', additionalProperties: false, properties: {} }),
    },
    {
      name: 'get_automation',
      description: 'The full document of one rule this home has.',
      schema: () => json(z.object({ automationId: z.string() }).strict()),
    },
    {
      name: 'control_device',
      description:
        'Work one device — switch it, dim it, set a colour, move a blind, lock a lock. This ' +
        'really does it; there is no preview and nothing to confirm afterwards. Send one call ' +
        'per device, and check the device has the capability first if you are not sure. Units ' +
        'are exact: levels are 1–254 and never percentages, temperatures are hundredths of a ' +
        'degree, a covering percent is hundredths of a percent with 0 fully open.',
      schema: () => json(controlDeviceInput),
    },
    {
      name: 'run_automation',
      description:
        'Press a rule the person could press — a button, or a mode switched the other way. ' +
        'Only for rules `list_automations` gives a shape of `button` or `toggle`; a `watching` ' +
        'rule has nothing to press and is left alone.',
      schema: () => json(runAutomationInput),
    },
    {
      name: 'ask_user',
      description:
        'Ask the person one question and wait for their answer. Offer two to four concrete ' +
        'options whenever you can — they will tap one. Use this when two readings of what they ' +
        'asked would lead to different actions, not for details you can decide well yourself.',
      schema: () => json(askUserInput),
    },
    {
      name: 'delegate',
      description:
        'Hand a whole job to the agent that does it, and carry on. You do not wait for it and ' +
        'you never see its working — the person watches it happen and answers it directly. ' +
        'Write `brief` as one self-contained message in their own language, carrying everything ' +
        'that agent needs and nothing about this conversation. Agents:\n' +
        delegates.map((entry) => `- ${entry.key}: ${entry.description}`).join('\n'),
      schema: () => json(delegateInput),
    },
  ];
}

// ── Running them ─────────────────────────────────────────────────────────────

/**
 * Answer a tool call.
 *
 * Never throws, for the reason `runAutomationTool` never does: a tool that
 * failed is a `tool_result` the model can read and work around, and an
 * exception here would end a conversation somebody is sitting in front of.
 * `ask_user` and `delegate` are not handled — the loop intercepts them, and
 * reaching here with one means the loop has a hole.
 */
export async function runAssistantTool(
  name: string,
  rawInput: unknown,
  context: AssistantToolContext,
  budget: { commands: number },
): Promise<AutomationToolResult> {
  try {
    switch (name) {
      case 'list_devices':
      case 'get_device':
      case 'list_rooms_zones':
      case 'get_automation':
        // The automations agent's own handlers, called rather than copied.
        return runAutomationTool(name, rawInput, {
          home: context.home,
          timezone: context.timezone,
          stateOf: context.stateOf,
        });

      case 'list_automations': {
        const rules = context.home().automations;
        return {
          detail: `${rules.length} ${rules.length === 1 ? 'rule' : 'rules'}`,
          text: JSON.stringify(
            rules.map((rule) => ({
              id: rule.id,
              name: rule.name,
              enabled: rule.enabled,
              // The hub's own word for what kind of thing it is — `button`,
              // `toggle` or `watching` — which is the same one the apps draw
              // the difference from, rather than a second vocabulary here.
              shape: automationShape(rule.document),
            })),
          ),
        };
      }

      case 'control_device': {
        const parsed = controlDeviceInput.safeParse(rawInput);
        if (!parsed.success) {
          return {
            isError: true,
            text: `That command could not be sent: ${parsed.error.issues
              .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
              .join('; ')}`,
          };
        }
        if (budget.commands >= ASSISTANT_MAX_COMMANDS_PER_TURN) {
          return {
            isError: true,
            text:
              `That is more than ${ASSISTANT_MAX_COMMANDS_PER_TURN} devices in one reply. The ` +
              'ones already sent have gone; tell them what you did and ask before doing more.',
          };
        }
        const device = context.home().devices.find((entry) => entry.id === parsed.data.deviceId);
        if (!device) {
          return { isError: true, text: 'There is no device with that id in this home.' };
        }
        const endpointId = parsed.data.endpointId ?? device.endpoints[0]?.endpointId ?? 1;
        try {
          await context.control(device.id, endpointId, parsed.data.command as HubCommand);
        } catch (error) {
          return { isError: true, text: `The hub refused that: ${(error as Error).message}` };
        }
        budget.commands += 1;
        return {
          detail: `${device.name}: ${parsed.data.command.type}`,
          text: `Sent. Note that reaching a battery device can take until it next wakes.`,
        };
      }

      case 'run_automation': {
        const parsed = runAutomationInput.safeParse(rawInput);
        if (!parsed.success) {
          return { isError: true, text: 'That needs the id of a rule in this home.' };
        }
        const rule = context
          .home()
          .automations.find((entry) => entry.id === parsed.data.automationId);
        if (!rule) return { isError: true, text: 'There is no rule with that id in this home.' };
        const ran = await context.runAutomation(rule.id);
        if (!ran) {
          return {
            isError: true,
            text: 'That rule is not one that can be pressed, or is switched off.',
          };
        }
        return { detail: rule.name, text: `Ran "${rule.name}".` };
      }

      default:
        return { isError: true, text: `There is no tool called ${name}.` };
    }
  } catch (error) {
    return { isError: true, text: `That step failed: ${(error as Error).message}` };
  }
}

export { delegateInput };
