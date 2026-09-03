import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { automationDocumentSchema } from '../src/automations/schema.js';
import { automationOutline, type AutomationOutlineNode } from '../src/automations/outline.js';
import type { AutomationHomeView } from '../src/automations/targets.js';

/**
 * The storyboard both apps draw a rule from.
 *
 * `summary` is the contract and this is the picture beside it — same document,
 * same home, one more interpretation. Neither app decodes the DSL, so
 * everything a person sees about *what a rule does* comes out of these two
 * functions: a mistake here is a rule drawn wrong on every phone in the house,
 * with nothing on either side to notice it.
 */

const kitchenId = randomUUID();
const lightId = randomUUID();
const motionId = randomUUID();
const blindId = randomUUID();
const buttonId = randomUUID();
const otherRuleId = randomUUID();

function home(): AutomationHomeView {
  return {
    rooms: [{ id: kitchenId, name: 'Kitchen', zoneId: null }],
    zones: [],
    automations: [
      {
        id: otherRuleId,
        name: 'Security',
        enabled: true,
        document: automationDocumentSchema.parse({
          name: 'Security',
          triggers: [{ kind: 'manual' }],
          actions: [{ kind: 'logActivity', message: 'armed' }],
          offActions: [{ kind: 'logActivity', message: 'disarmed' }],
        }),
      },
    ],
    devices: [
      {
        id: lightId,
        name: 'Ceiling light',
        roomId: kitchenId,
        online: true,
        endpoints: [
          {
            endpointId: 1,
            deviceKind: 'light',
            capabilities: ['onOff', 'level', 'colorTemperature'],
          },
        ],
      },
      {
        id: motionId,
        name: 'Hall motion',
        roomId: kitchenId,
        online: true,
        endpoints: [{ endpointId: 1, deviceKind: 'sensor', capabilities: ['occupancy', 'battery'] }],
      },
      {
        id: blindId,
        name: 'Kitchen blind',
        roomId: kitchenId,
        online: true,
        endpoints: [{ endpointId: 1, deviceKind: 'shade', capabilities: ['windowCovering'] }],
      },
      {
        id: buttonId,
        name: 'Bedside button',
        roomId: kitchenId,
        online: true,
        endpoints: [{ endpointId: 1, deviceKind: 'remote', capabilities: ['event'] }],
      },
    ],
  };
}

function outline(document: unknown) {
  return automationOutline(automationDocumentSchema.parse(document), home());
}

/** A document whose only interesting half is the one a test is about. */
function around(parts: Record<string, unknown>) {
  return {
    name: 'A rule',
    triggers: [{ kind: 'manual' }],
    actions: [{ kind: 'logActivity', message: 'done' }],
    ...parts,
  };
}

describe('a rule as a storyboard', () => {
  it('splits into when, only if and then', () => {
    const drawn = outline({
      name: 'Light on motion',
      triggers: [
        {
          kind: 'deviceState',
          target: { deviceIds: [motionId] },
          path: 'sensors.occupied',
          op: 'eq',
          value: true,
        },
      ],
      conditions: [{ kind: 'timeRange', from: '22:00', to: '06:00' }],
      actions: [
        { kind: 'deviceCommand', target: { deviceIds: [lightId] }, command: { type: 'power', on: true } },
        { kind: 'wait', ms: 180_000 },
        { kind: 'deviceCommand', target: { deviceIds: [lightId] }, command: { type: 'power', on: false } },
      ],
    });

    expect(drawn.when).toEqual([
      { glyph: 'motion', title: 'Motion detected', subject: 'Hall motion' },
    ]);
    expect(drawn.onlyIf).toEqual([
      // 22:00 to 06:00 is one night rather than an empty window.
      { glyph: 'clock', title: 'Between 22:00 and 06:00', detail: 'overnight' },
    ]);
    expect(drawn.then).toEqual([
      { glyph: 'powerOn', title: 'Switch on', subject: 'Ceiling light' },
      { glyph: 'wait', title: 'Wait 3 minutes', tone: 'quiet' },
      { glyph: 'powerOff', title: 'Switch off', subject: 'Ceiling light' },
    ]);
    // A rule that is not a toggle has no off-branch at all, rather than an
    // empty one an app would have to know to hide.
    expect(drawn.otherwise).toBeUndefined();
  });

  it('says a stored number in the unit a person means by it', () => {
    // The mistake the catalog warns the *agent* about, on the way back out:
    // 2500 is 25 °C, and a card reading "goes above 2500" is wrong by two
    // orders of magnitude and reads perfectly.
    const [step] = outline(
      around({
        triggers: [
          {
            kind: 'deviceState',
            target: { select: { capability: 'temperature', roomId: kitchenId } },
            path: 'sensors.temperatureCenti',
            op: 'gt',
            value: 2500,
            for: 60_000,
            hysteresis: 50,
          },
        ],
      }),
    ).when;

    expect(step).toEqual({
      glyph: 'temperature',
      title: 'Temperature goes above 25 °C',
      subject: 'any of the temperature sensors in Kitchen',
      // Both qualifiers, because they are not the same thing: one suppresses a
      // spike and the other a value dithering on the threshold.
      detail: 'held for 1 minute · re-arms after 0.5 °C',
    });
  });

  it('reads a boolean path as the thing that happened, in both directions', () => {
    const opens = outline(
      around({
        triggers: [
          {
            kind: 'deviceState',
            target: { deviceIds: [motionId] },
            path: 'sensors.occupied',
            op: 'eq',
            value: false,
          },
        ],
      }),
    ).when[0];
    expect(opens?.title).toBe('Motion stops');

    // `ne true` is the same sentence with the answer flipped, and printing a
    // comparator beside it would give "Occupancy is not yes".
    const negated = outline(
      around({
        triggers: [
          {
            kind: 'deviceState',
            target: { deviceIds: [motionId] },
            path: 'sensors.occupied',
            op: 'ne',
            value: true,
          },
        ],
      }),
    ).when[0];
    expect(negated?.title).toBe('Motion stops');
  });

  it('uses the crossing tense for a trigger and the resting tense for a condition', () => {
    const test = {
      target: { deviceIds: [motionId] },
      path: 'battery.percent',
      op: 'lt',
      value: 20,
    };
    const drawn = outline(
      around({
        triggers: [{ kind: 'deviceState', ...test }],
        conditions: [{ kind: 'deviceState', ...test }],
      }),
    );

    // A trigger is the moment of crossing — the whole of what edge-triggering
    // means — and a condition is asked while the rule is already running.
    expect(drawn.when[0]?.title).toBe('Battery goes below 20%');
    expect(drawn.onlyIf[0]?.title).toBe('Battery is below 20%');
  });

  it('quantifies a trigger by any and a condition by what the author asked for', () => {
    const drawn = outline(
      around({
        triggers: [
          {
            kind: 'deviceState',
            target: { select: { capability: 'occupancy' } },
            path: 'sensors.occupied',
            op: 'eq',
            value: true,
          },
        ],
        conditions: [
          {
            kind: 'deviceState',
            target: { select: { capability: 'onOff' } },
            path: 'onOff',
            op: 'eq',
            value: false,
            match: 'all',
          },
        ],
      }),
    );

    // The engine evaluates a trigger per device and fires the moment any one
    // of them crosses; saying "all" would claim a rule waits for the house.
    expect(drawn.when[0]?.subject).toBe('any of the motion sensors');
    expect(drawn.onlyIf[0]?.subject).toBe('all the devices that switch on and off');
  });

  it('names the rule a reference points at, and says when it is gone', () => {
    const drawn = outline(
      around({
        conditions: [{ kind: 'automationActive', automationId: otherRuleId, is: true }],
        actions: [
          { kind: 'setAutomationActive', automationId: otherRuleId, active: false },
          { kind: 'runAutomation', automationId: randomUUID() },
        ],
      }),
    );

    expect(drawn.onlyIf[0]).toEqual({ glyph: 'rule', title: '“Security” is on' });
    expect(drawn.then[0]).toEqual({
      glyph: 'rule',
      title: 'Turn “Security” off',
      detail: 'the mode',
    });
    // A document outlives the rule it names, and a UUID on a card says less
    // than nothing.
    expect(drawn.then[1]?.title).toBe('Run a rule that is no longer here');
  });

  it('nests a group and keeps its join word', () => {
    const [group] = outline(
      around({
        conditions: [
          {
            kind: 'any',
            conditions: [
              { kind: 'dayOfWeek', days: [0, 6] },
              { kind: 'not', condition: { kind: 'timeRange', from: '09:00', to: '17:00' } },
            ],
          },
        ],
      }),
    ).onlyIf;

    expect(group?.join).toBe('any');
    expect(group?.children?.map((child: AutomationOutlineNode) => child.title)).toEqual([
      'It is weekends',
      'None of this',
    ]);
    expect(group?.children?.[1]?.children?.[0]?.title).toBe('Between 09:00 and 17:00');
  });

  it('converts a command into the units it was written in', () => {
    const drawn = outline(
      around({
        actions: [
          {
            kind: 'deviceCommand',
            target: { deviceIds: [lightId] },
            command: { type: 'setLevel', level: 128 },
          },
          {
            kind: 'deviceCommand',
            target: { deviceIds: [lightId] },
            command: { type: 'setColorTemperature', mireds: 370 },
          },
          {
            kind: 'deviceCommand',
            target: { deviceIds: [blindId] },
            command: { type: 'setCoveringPercent', percent100ths: 2500 },
          },
        ],
      }),
    );

    expect(drawn.then[0]?.detail).toBe('to 50%');
    expect(drawn.then[1]?.detail).toBe('to 2703 K');
    // **Closed, not open.** 0 is fully open in Matter's own units, so 2500 is
    // a blind a quarter of the way down — the opposite of what "% open" said.
    expect(drawn.then[2]?.detail).toBe('to 25% closed');
  });

  it('draws a toggle as two branches', () => {
    const drawn = outline({
      name: 'Security',
      triggers: [{ kind: 'manual' }],
      actions: [
        { kind: 'deviceCommand', target: { deviceIds: [blindId] }, command: { type: 'closeCovering' } },
      ],
      offActions: [
        { kind: 'deviceCommand', target: { deviceIds: [blindId] }, command: { type: 'openCovering' } },
      ],
    });

    expect(drawn.when).toEqual([{ glyph: 'press', title: 'Somebody presses it' }]);
    expect(drawn.then[0]?.title).toBe('Close');
    expect(drawn.otherwise?.[0]?.title).toBe('Open');
  });

  it('says what a button press was', () => {
    const [step] = outline(
      around({
        triggers: [
          { kind: 'deviceEvent', target: { deviceIds: [buttonId] }, button: '1', gesture: 'double' },
        ],
      }),
    ).when;

    expect(step).toEqual({
      glyph: 'button',
      title: 'A button is pressed',
      subject: 'Bedside button',
      detail: 'double · 1',
    });
  });

  it('gives every step a title, whatever the document holds', () => {
    // The property that makes this safe to draw: an app renders `title` and
    // falls back on an unknown `glyph`, so a step kind added later is still a
    // line that says something true rather than a blank row.
    const drawn = outline({
      name: 'Everything',
      triggers: [
        { kind: 'manual' },
        { kind: 'schedule', at: '07:00', days: [1, 2, 3, 4, 5] },
        { kind: 'interval', everyMs: 3_600_000 },
      ],
      conditions: [{ kind: 'dayOfWeek', days: [1, 2, 3, 4, 5, 6, 0] }],
      actions: [
        { kind: 'logActivity', message: 'hello' },
        { kind: 'wait', ms: 30_000 },
        {
          kind: 'deviceCommand',
          target: { select: { kind: 'light', roomId: kitchenId } },
          command: { type: 'toggle' },
        },
      ],
    });

    for (const step of [...drawn.when, ...drawn.onlyIf, ...drawn.then]) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.glyph.length).toBeGreaterThan(0);
    }
    expect(drawn.when.map((step) => step.title)).toEqual([
      'Somebody presses it',
      'At 07:00',
      'Every 1 hour',
    ]);
    expect(drawn.onlyIf[0]?.title).toBe('It is every day');
    expect(drawn.then[2]?.subject).toBe('all the lights in Kitchen');
  });
});
