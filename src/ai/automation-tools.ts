import { z } from 'zod';
import type { EndpointState } from '../schema/index.js';
import { automationDocumentSchema } from '../automations/schema.js';
import { sanityCheckAutomation } from '../automations/sanity.js';
import { automationShape, describeAutomation } from '../automations/summarize.js';
import type { AutomationHomeView } from '../automations/targets.js';
import type { AutomationStepKind } from './automation-conversation.js';

/**
 * The automation agent's tools, and **no SDK is imported here**.
 *
 * The `agent-core.ts` rule: everything that is not one vendor's API lives
 * where both loops can reach it, so the OpenAI half — when it arrives — gets
 * the same tool surface without a second copy of it to keep in step. What a
 * vendor loop does with these is declare them in its own shape and call
 * `runAutomationTool` with whatever the model sent.
 *
 * Two of the seven are **intercepted by the loop rather than answered here**:
 * `ask_user` suspends the conversation, and `submit_automation` ends it. They
 * are declared here anyway, because their schemas are as much part of the tool
 * surface as the others and a second place to declare them is a second place
 * to drift.
 *
 * There is deliberately **no web access and no filesystem**. An agent writing
 * a rule for somebody's house has nothing to look up, and the absence is
 * worth stating: this is the one AI surface in the hub that talks to the
 * provider's API and to nothing else at all.
 */

export interface AutomationToolContext {
  home: () => AutomationHomeView;
  timezone: () => string;
  /** Current state, for the one device that turns out to matter. */
  stateOf: (deviceId: string, endpointId: number) => EndpointState | undefined;
}

export interface AutomationToolResult {
  text: string;
  isError?: boolean;
  /**
   * The one line a *person* should read under this step, when there is one.
   *
   * The `text` above is for the model — JSON, whole documents, the home's
   * inventory — and none of it belongs on a phone. This is what actually
   * happened, in the words the sentence beside it is written in: which device
   * was looked at, how many matched, whether the draft would be accepted. It
   * rides the same `step` frame `ask_user`'s question does and is the whole of
   * the difference between "Checking the rule would work" and "Checking the
   * rule would work — When the living room sensor sees somebody, switch the
   * lamp on".
   *
   * Kept short: it is stored on a transcript row (cut at 400 characters) and
   * drawn as one clamped line an app opens on a tap.
   */
  detail?: string;
}

export interface AutomationToolDefinition {
  name: string;
  description: string;
  schema: () => Record<string, unknown>;
}

// ── Schemas ──────────────────────────────────────────────────────────────────

const listDevicesInput = z
  .object({
    roomId: z.string().optional(),
    capability: z.string().optional(),
  })
  .strict();

const getDeviceInput = z.object({ deviceId: z.string() }).strict();
const getAutomationInput = z.object({ automationId: z.string() }).strict();
const dryRunInput = z.object({ document: z.unknown() }).strict();

/**
 * One question, with answers a person can tap.
 *
 * The options are the whole point. Somebody who does not write software will
 * answer "which of your three lamps?" by tapping one and will not answer
 * "what should the hysteresis be?" at all — so the tool that asks is shaped to
 * make tapping the normal case and typing the exception.
 */
export const askUserInput = z
  .object({
    question: z.string().min(1).max(400),
    options: z
      .array(
        z
          .object({
            id: z.string().min(1).max(60),
            label: z.string().min(1).max(120),
            hint: z.string().max(200).optional(),
          })
          .strict(),
      )
      .max(4)
      .optional(),
    /** Whether typing something else is offered beside the options. */
    allowFreeText: z.boolean().optional(),
  })
  .strict();

export type AskUser = z.infer<typeof askUserInput>;

export const submitAutomationInput = z
  .object({
    document: z.unknown(),
    /** One line for the version history: what changed and why. */
    note: z.string().max(200).optional(),
  })
  .strict();

function json(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  delete generated.$schema;
  return generated;
}

/**
 * `document` is the live `AutomationDocument` schema, generated — so the model
 * receives exactly what the validator will accept, including the whitelisted
 * state paths as an enum, and the two cannot drift.
 *
 * Deliberately **not** used with either vendor's *strict* mode, the
 * `submit_mapping` reasoning: strict tool use guarantees the shape and cannot
 * express the semantics — that a command's target must have the capability,
 * that a threshold on a noisy reading needs a hold — and it rejects the
 * numeric constraints this schema uses. A real sentence explaining what is
 * wrong is worth more than a narrowed schema, and the validate-and-resubmit
 * loop is what delivers it.
 */
function submitSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['document'],
    properties: {
      document: json(automationDocumentSchema),
      note: { type: 'string', maxLength: 200, description: 'One line for the version history.' },
    },
  };
}

/**
 * What each tool is called *to a person*, and what kind of act it is.
 *
 * The vocabulary lives here rather than in the loop because this is where the
 * tools are, so adding one puts its sentence in the same edit. And it is a
 * sentence rather than the tool's name: "Looked up list_rooms_zones." is a
 * function signature read out loud, on the one screen in the app whose whole
 * job is telling somebody who does not write software what their house is
 * doing.
 *
 * Present tense and unfinished on purpose — a step goes up *while* it is
 * happening, and reads as a caption under a spinner rather than a log line.
 */
export const AUTOMATION_TOOL_STEPS: Readonly<
  Record<string, { summary: string; kind: AutomationStepKind }>
> = {
  list_devices: { summary: 'Looking at your devices', kind: 'reading' },
  get_device: { summary: 'Looking at one device closely', kind: 'reading' },
  list_rooms_zones: { summary: 'Looking at your rooms', kind: 'reading' },
  get_automation: { summary: 'Reading a rule you already have', kind: 'reading' },
  dry_run: { summary: 'Checking the rule would work', kind: 'checking' },
  ask_user: { summary: 'Asking you something', kind: 'asking' },
  submit_automation: { summary: 'Writing the rule', kind: 'writing' },
};

/** The step for a tool, falling back to something true for one this build's
 *  table has not got — a new tool must never produce a blank line. */
export function toolStep(name: string): { summary: string; kind: AutomationStepKind } {
  return AUTOMATION_TOOL_STEPS[name] ?? { summary: 'Working on it', kind: 'thinking' };
}

export const AUTOMATION_TOOLS: readonly AutomationToolDefinition[] = [
  {
    name: 'list_devices',
    description:
      'Every device in the home, optionally narrowed to a room or to devices with a given ' +
      'capability. The first message already carries this list; call it again to filter, or ' +
      'after a change.',
    schema: () => json(listDevicesInput),
  },
  {
    name: 'get_device',
    description:
      'One device in full: its endpoints, what each can do, what it is reporting right now, and ' +
      'any generic settings it exposes. Use it when a rule turns on a detail — which endpoint, ' +
      'what a value currently reads, what a custom field is called.',
    schema: () => json(getDeviceInput),
  },
  {
    name: 'list_rooms_zones',
    description: 'The rooms and zones of this home, with their ids, for writing selectors.',
    schema: () => ({ type: 'object', additionalProperties: false, properties: {} }),
  },
  {
    name: 'get_automation',
    description: 'The full document of a rule this home already has.',
    schema: () => json(getAutomationInput),
  },
  {
    name: 'dry_run',
    description:
      'Check a draft without saving it. Answers with the problems that would refuse it, the ' +
      'warnings worth knowing (a loop, a selector that matches nothing yet), and the sentence ' +
      'the apps will show — which is the best way to see whether the rule says what was meant. ' +
      'Call this before you submit.',
    schema: () => json(dryRunInput),
  },
  {
    name: 'ask_user',
    description:
      'Ask the person one question and wait for their answer. Offer two to four concrete options ' +
      'whenever you can — they will tap one. Use this when two readings of what they asked would ' +
      'produce different rules, not for details you can decide well yourself.',
    schema: () => json(askUserInput),
  },
  {
    name: 'submit_automation',
    description:
      'Deliver the finished rule. This is the only way to *save* one — nothing in the home ' +
      'changes until you call it — but it is not how you answer: prose reaches the person on ' +
      'its own, so a question is answered by writing back and nothing else. If the document is ' +
      'refused the reasons come back — fix them and submit again.',
    schema: submitSchema,
  },
];

// ── Running them ─────────────────────────────────────────────────────────────

/**
 * Answer a tool call.
 *
 * Never throws: a tool that failed is a `tool_result` the model can read and
 * work around, and an exception here would end a conversation somebody is
 * sitting in front of. `ask_user` and `submit_automation` are not handled —
 * the loop intercepts them before this is called, and reaching here with one
 * means the loop has a hole, which is worth saying out loud rather than
 * silently answering.
 */
export function runAutomationTool(
  name: string,
  rawInput: unknown,
  context: AutomationToolContext,
): AutomationToolResult {
  try {
    switch (name) {
      case 'list_devices': {
        const input = listDevicesInput.parse(rawInput ?? {});
        const home = context.home();
        const matched = home.devices.filter((device) => {
          if (input.roomId !== undefined && device.roomId !== input.roomId) return false;
          if (
            input.capability !== undefined &&
            !device.endpoints.some((endpoint) =>
              (endpoint.capabilities as readonly string[]).includes(input.capability!),
            )
          ) {
            return false;
          }
          return true;
        });
        const room = input.roomId
          ? home.rooms.find((entry) => entry.id === input.roomId)?.name
          : undefined;
        const narrowed = [
          input.capability !== undefined ? `that can ${input.capability}` : undefined,
          room !== undefined ? `in the ${room}` : undefined,
        ].filter((part): part is string => part !== undefined);
        return {
          detail:
            `${matched.length} ${matched.length === 1 ? 'device' : 'devices'}` +
            (narrowed.length > 0 ? ` ${narrowed.join(' ')}` : ''),
          text: JSON.stringify(
            matched.map((device) => ({
              id: device.id,
              name: device.name,
              roomId: device.roomId,
              online: device.online,
              endpoints: device.endpoints.map((endpoint) => ({
                endpointId: endpoint.endpointId,
                deviceKind: endpoint.deviceKind,
                capabilities: endpoint.capabilities,
              })),
            })),
            null,
            2,
          ),
        };
      }

      case 'get_device': {
        const { deviceId } = getDeviceInput.parse(rawInput);
        const device = context.home().devices.find((entry) => entry.id === deviceId);
        if (!device) return { text: `No device with id ${deviceId} in this home.`, isError: true };
        return {
          detail: device.name,
          text: JSON.stringify(
            {
              id: device.id,
              name: device.name,
              roomId: device.roomId,
              online: device.online,
              endpoints: device.endpoints.map((endpoint) => ({
                endpointId: endpoint.endpointId,
                deviceKind: endpoint.deviceKind,
                capabilities: endpoint.capabilities,
                state: context.stateOf(device.id, endpoint.endpointId) ?? null,
              })),
            },
            null,
            2,
          ),
        };
      }

      case 'list_rooms_zones': {
        const home = context.home();
        const rooms = `${home.rooms.length} ${home.rooms.length === 1 ? 'room' : 'rooms'}`;
        const zones =
          home.zones.length > 0
            ? ` · ${home.zones.length} ${home.zones.length === 1 ? 'zone' : 'zones'}`
            : '';
        return {
          detail: `${rooms}${zones}`,
          text: JSON.stringify({ rooms: home.rooms, zones: home.zones }, null, 2),
        };
      }

      case 'get_automation': {
        const { automationId } = getAutomationInput.parse(rawInput);
        const entry = context.home().automations.find((item) => item.id === automationId);
        if (!entry) {
          return { text: `No automation with id ${automationId} in this home.`, isError: true };
        }
        return { detail: entry.name, text: JSON.stringify(entry.document, null, 2) };
      }

      case 'dry_run': {
        const { document } = dryRunInput.parse(rawInput ?? {});
        const parsed = automationDocumentSchema.safeParse(document);
        if (!parsed.success) {
          return {
            text:
              'The document does not match the schema:\n' +
              parsed.error.issues
                .map((issue) => `- ${issue.path.join('.') || '(root)'}: ${issue.message}`)
                .join('\n'),
            isError: true,
          };
        }
        const home = context.home();
        const report = sanityCheckAutomation(parsed.data, home);
        const summary = describeAutomation(parsed.data, home);
        return {
          // **The sentence the apps would show, or the first reason it would
          // be refused.** This is the most useful line the whole trail carries:
          // it is what the rule *says* it will do, read out while the agent is
          // still deciding, so somebody watching sees the rule before the card
          // arrives rather than only afterwards.
          detail: report.problems[0] ?? summary,
          text: JSON.stringify(
            {
              ...report,
              shape: automationShape(parsed.data),
              summary,
              wouldBeAccepted: report.problems.length === 0,
            },
            null,
            2,
          ),
        };
      }

      case 'ask_user':
      case 'submit_automation':
        return {
          text: `"${name}" is handled by the conversation and should not have reached here.`,
          isError: true,
        };

      default:
        return { text: `Unknown tool "${name}".`, isError: true };
    }
  } catch (error) {
    return { text: `That call could not be made: ${(error as Error).message}`, isError: true };
  }
}
