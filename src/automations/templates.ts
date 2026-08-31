import type { CapabilityKind } from '../schema/index.js';
import { automationDocumentSchema, type AutomationDocument } from './schema.js';

/**
 * The automations a home starts with — the answer to "what can this thing
 * actually do for me" before anybody has typed a word at the agent.
 *
 * Two rules shape all of them.
 *
 * **They are written with selectors, not device ids.** A template is authored
 * here, months before it meets a home, so it cannot name anything; and once
 * installed it keeps meaning what it said as the home changes — a lamp paired
 * next spring joins "Night" without anybody editing the rule. That is the
 * same argument that put selectors in the DSL at all, and templates are where
 * it stops being a convenience and becomes a requirement.
 *
 * **A template may install more than one rule**, which is why `build` returns
 * an array. "Light on motion" is genuinely two rules — one that switches on
 * when somebody arrives, one that switches off when the room has been still
 * for a while — because an action list runs top to bottom and has no branch
 * in it. Modelling that as one rule would mean inventing an if/else in the
 * DSL for a case two documents express perfectly.
 *
 * What is deliberately **not** here: anything that unlocks a door on its own,
 * anything that depends on notifications (the hub has no push channel yet),
 * and anything built on a capability the schema does not have — a water-leak
 * template would need a leak capability, and shipping one that quietly
 * matches nothing is worse than not shipping it.
 */

export interface TemplateInput {
  key: string;
  label: string;
  hint?: string;
  kind: 'room' | 'device' | 'time';
  /** For `device`: what the picker should offer. */
  capability?: CapabilityKind;
  /** For `time`: a sensible starting value, `HH:MM`. */
  default?: string;
}

export interface AutomationTemplate {
  key: string;
  title: string;
  summary: string;
  /** An SF Symbol name. The apps draw it; the hub never interprets it. */
  glyph: string;
  inputs: TemplateInput[];
  /**
   * The rules this template installs, already parsed — so a template that has
   * drifted from the schema throws here rather than being written to the
   * database and failing to run.
   */
  build(values: Record<string, string>): AutomationDocument[];
}

/** Every light, switch and outlet — what "turn everything off" means. */
const SWITCHABLE: CapabilityKind = 'onOff';

function parse(document: unknown): AutomationDocument {
  return automationDocumentSchema.parse(document);
}

export const AUTOMATION_TEMPLATES: readonly AutomationTemplate[] = [
  {
    key: 'away',
    title: 'I’m leaving',
    summary: 'One press: the lights and sockets go off and the doors lock.',
    glyph: 'figure.walk.departure',
    inputs: [],
    build: () => [
      parse({
        name: 'I’m leaving',
        description: 'Switches everything off and locks up.',
        triggers: [{ kind: 'manual' }],
        actions: [
          {
            kind: 'deviceCommand',
            target: { select: { kind: 'light', capability: SWITCHABLE } },
            command: { type: 'power', on: false },
          },
          {
            kind: 'deviceCommand',
            target: { select: { kind: 'outlet', capability: SWITCHABLE } },
            command: { type: 'power', on: false },
          },
          {
            kind: 'deviceCommand',
            target: { select: { kind: 'speaker', capability: SWITCHABLE } },
            command: { type: 'power', on: false },
          },
          {
            kind: 'deviceCommand',
            target: { select: { capability: 'doorLock' } },
            command: { type: 'lock', engage: true },
          },
        ],
      }),
    ],
  },

  {
    key: 'night',
    title: 'Night',
    summary: 'A mode you switch on at bedtime: lights out, doors locked, curtains closed.',
    glyph: 'moon.stars',
    inputs: [],
    build: () => [
      parse({
        name: 'Night',
        description: 'On: lights out, locked, curtains closed. Off: the curtains open again.',
        triggers: [{ kind: 'manual' }],
        actions: [
          {
            kind: 'deviceCommand',
            target: { select: { kind: 'light', capability: SWITCHABLE } },
            command: { type: 'power', on: false },
          },
          {
            kind: 'deviceCommand',
            target: { select: { capability: 'doorLock' } },
            command: { type: 'lock', engage: true },
          },
          {
            kind: 'deviceCommand',
            target: { select: { capability: 'windowCovering' } },
            command: { type: 'closeCovering' },
          },
        ],
        // Present, so this is a toggle rather than a button — see `isToggle`.
        offActions: [
          {
            kind: 'deviceCommand',
            target: { select: { capability: 'windowCovering' } },
            command: { type: 'openCovering' },
          },
        ],
      }),
    ],
  },

  {
    key: 'security',
    title: 'Security',
    summary:
      'A mode that locks up and that other rules can ask about — "only while Security is on".',
    glyph: 'lock.shield',
    inputs: [],
    build: () => [
      parse({
        name: 'Security',
        /**
         * Switching it off deliberately does **not** unlock anything. A rule
         * that opens a house because somebody tapped a card is not a
         * convenience, and there is no way to ask "are you sure" from inside
         * an action list. Turning Security off means the *other* rules stop
         * asking about it, which is the whole point of a mode.
         */
        description: 'On: everything locks. Off: nothing unlocks — that is a decision for a person.',
        triggers: [{ kind: 'manual' }],
        actions: [
          {
            kind: 'deviceCommand',
            target: { select: { capability: 'doorLock' } },
            command: { type: 'lock', engage: true },
          },
          { kind: 'logActivity', message: 'Security switched on' },
        ],
        offActions: [{ kind: 'logActivity', message: 'Security switched off' }],
      }),
    ],
  },

  {
    key: 'morning',
    title: 'Morning',
    summary: 'At a time you choose, the curtains open.',
    glyph: 'sunrise',
    inputs: [
      { key: 'at', kind: 'time', label: 'What time?', default: '07:00' },
    ],
    build: (values) => [
      parse({
        name: 'Morning',
        description: 'Opens the curtains on weekday mornings.',
        triggers: [{ kind: 'schedule', at: values.at ?? '07:00', days: [1, 2, 3, 4, 5] }],
        actions: [
          {
            kind: 'deviceCommand',
            target: { select: { capability: 'windowCovering' } },
            command: { type: 'openCovering' },
          },
        ],
      }),
    ],
  },

  {
    key: 'motion_light',
    title: 'Light on movement',
    summary: 'A room’s lights come on when somebody walks in, and go off once it has been still.',
    glyph: 'sensor',
    inputs: [
      {
        key: 'roomId',
        kind: 'room',
        label: 'Which room?',
        hint: 'It needs a motion sensor and a light in it.',
      },
    ],
    build: (values) => {
      const roomId = values.roomId;
      if (roomId === undefined) throw new Error('motion_light needs a room');
      return [
        parse({
          name: 'Lights on with movement',
          triggers: [
            {
              kind: 'deviceState',
              target: { select: { roomId, capability: 'occupancy' } },
              path: 'sensors.occupied',
              op: 'eq',
              value: true,
            },
          ],
          actions: [
            {
              kind: 'deviceCommand',
              target: { select: { roomId, kind: 'light', capability: SWITCHABLE } },
              command: { type: 'power', on: true },
            },
          ],
        }),
        parse({
          name: 'Lights off when still',
          /**
           * Five minutes of stillness rather than the moment the sensor
           * clears: a PIR drops occupancy the second nobody moves, and a room
           * that goes dark while somebody is reading in it is the reason
           * people give up on motion lighting.
           */
          triggers: [
            {
              kind: 'deviceState',
              target: { select: { roomId, capability: 'occupancy' } },
              path: 'sensors.occupied',
              op: 'eq',
              value: false,
              for: 5 * 60_000,
            },
          ],
          actions: [
            {
              kind: 'deviceCommand',
              target: { select: { roomId, kind: 'light', capability: SWITCHABLE } },
              command: { type: 'power', on: false },
            },
          ],
        }),
      ];
    },
  },

  {
    key: 'smoke_lights',
    title: 'Lights on if the smoke alarm goes',
    summary: 'Every light in the house comes on when a smoke or CO alarm reaches critical.',
    glyph: 'flame',
    inputs: [],
    build: () => [
      parse({
        name: 'Lights on if the smoke alarm goes',
        description: 'Somewhere to walk to, in the dark, in a hurry.',
        triggers: [
          {
            kind: 'deviceState',
            target: { select: { capability: 'smokeCOAlarm' } },
            path: 'sensors.smokeAlarm',
            op: 'gte',
            value: 2,
          },
          {
            kind: 'deviceState',
            target: { select: { capability: 'smokeCOAlarm' } },
            path: 'sensors.coAlarm',
            op: 'gte',
            value: 2,
          },
        ],
        actions: [
          {
            kind: 'deviceCommand',
            target: { select: { kind: 'light', capability: SWITCHABLE } },
            command: { type: 'power', on: true },
          },
          { kind: 'logActivity', message: 'An alarm went off — every light was switched on' },
        ],
      }),
    ],
  },

  {
    key: 'low_battery',
    title: 'Tell me about flat batteries',
    summary: 'Writes a line in the home’s history when a sensor’s battery drops below 15%.',
    glyph: 'battery.25',
    inputs: [],
    build: () => [
      parse({
        name: 'Flat batteries',
        triggers: [
          {
            kind: 'deviceState',
            target: { select: { capability: 'battery' } },
            path: 'battery.percent',
            op: 'lt',
            value: 15,
          },
        ],
        actions: [{ kind: 'logActivity', message: 'A device’s battery is below 15%' }],
        /**
         * The trigger already fires on the crossing rather than on every
         * report, so this is a second belt: a battery hovering either side of
         * 15% as the temperature changes would otherwise write a line each
         * time it wobbled, and the history is read a week later.
         */
        guards: { maxRunsPerHour: 2 },
      }),
    ],
  },
];

export function findTemplate(key: string): AutomationTemplate | undefined {
  return AUTOMATION_TEMPLATES.find((template) => template.key === key);
}
