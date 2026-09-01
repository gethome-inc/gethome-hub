import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_FAN_OUT,
  MIN_HOLD_MS,
  READABLE_PATHS,
  automationDocumentSchema,
  isManual,
  isToggle,
  type AutomationDocument,
} from '../src/automations/schema.js';
import { sanityCheckAutomation } from '../src/automations/sanity.js';
import { automationCatalog, catalogAsPrompt } from '../src/automations/catalog.js';
import { AUTOMATION_TEMPLATES, findTemplate } from '../src/automations/templates.js';
import { describeTarget, resolveTarget, type AutomationHomeView } from '../src/automations/targets.js';
import { describeAutomation } from '../src/automations/summarize.js';

// ── A small home to check documents against ──────────────────────────────────

const kitchenId = randomUUID();
const bedroomId = randomUUID();
const upstairsId = randomUUID();

const ceilingLightId = randomUUID();
const lampId = randomUUID();
const twoGangId = randomUUID();
const meterId = randomUUID();
const motionId = randomUUID();
const buttonId = randomUUID();
const lockId = randomUUID();
const blindId = randomUUID();
const smokeId = randomUUID();

function home(overrides: Partial<AutomationHomeView> = {}): AutomationHomeView {
  return {
    rooms: [
      { id: kitchenId, name: 'Kitchen', zoneId: null },
      { id: bedroomId, name: 'Bedroom', zoneId: upstairsId },
    ],
    zones: [{ id: upstairsId, name: 'Upstairs' }],
    automations: [],
    devices: [
      {
        id: ceilingLightId,
        name: 'Ceiling light',
        roomId: kitchenId,
        online: true,
        endpoints: [{ endpointId: 1, deviceKind: 'light', capabilities: ['onOff', 'level'] }],
      },
      {
        id: lampId,
        name: 'Bedside lamp',
        roomId: bedroomId,
        online: true,
        endpoints: [{ endpointId: 1, deviceKind: 'light', capabilities: ['onOff', 'level', 'color'] }],
      },
      {
        // Endpoint 1 is a plain relay; the dimming gang is endpoint 2. Nothing
        // an author should have to know — see `resolveTarget`.
        id: twoGangId,
        name: 'Hall switch',
        roomId: kitchenId,
        online: true,
        endpoints: [
          { endpointId: 1, deviceKind: 'wallSwitch', capabilities: ['onOff'] },
          { endpointId: 2, deviceKind: 'wallSwitch', capabilities: ['onOff', 'level'] },
        ],
      },
      {
        id: meterId,
        name: 'Washing machine plug',
        roomId: kitchenId,
        online: true,
        endpoints: [{ endpointId: 1, deviceKind: 'outlet', capabilities: ['onOff', 'electricalPower'] }],
      },
      {
        id: motionId,
        name: 'Hall motion',
        roomId: kitchenId,
        online: true,
        endpoints: [{ endpointId: 1, deviceKind: 'sensor', capabilities: ['occupancy', 'battery'] }],
      },
      {
        id: buttonId,
        name: 'Bedside button',
        roomId: bedroomId,
        online: true,
        endpoints: [{ endpointId: 1, deviceKind: 'remote', capabilities: ['event', 'battery'] }],
      },
      {
        id: lockId,
        name: 'Front door',
        roomId: kitchenId,
        online: false,
        endpoints: [{ endpointId: 1, deviceKind: 'lock', capabilities: ['doorLock'] }],
      },
      {
        id: blindId,
        name: 'Bedroom blind',
        roomId: bedroomId,
        online: true,
        endpoints: [{ endpointId: 1, deviceKind: 'shade', capabilities: ['windowCovering'] }],
      },
      {
        id: smokeId,
        name: 'Kitchen smoke alarm',
        roomId: kitchenId,
        online: true,
        endpoints: [{ endpointId: 1, deviceKind: 'sensor', capabilities: ['smokeCOAlarm', 'battery'] }],
      },
    ],
    ...overrides,
  };
}

/** A document as the *parse* would have produced it — defaults filled in. */
function parse(input: unknown): AutomationDocument {
  return automationDocumentSchema.parse(input);
}

const motionLight = {
  name: 'Light on motion',
  triggers: [
    { kind: 'deviceState', target: { deviceIds: [motionId] }, path: 'sensors.occupied', op: 'eq', value: true },
  ],
  actions: [
    { kind: 'deviceCommand', target: { deviceIds: [ceilingLightId] }, command: { type: 'power', on: true } },
  ],
};

// ── The document ─────────────────────────────────────────────────────────────

describe('automation document', () => {
  it('fills in the constants rather than demanding them', () => {
    const parsed = parse(motionLight);
    // The `descriptor.ts` lesson: a required literal cost five to seven paid
    // rounds per run because a good document kept being bounced for it.
    expect(parsed.version).toBe(1);
    expect(parsed.mode).toBe('single');
  });

  it('refuses a shape it does not know', () => {
    expect(() => parse({ ...motionLight, triggers: [{ kind: 'sunrise' }] })).toThrow();
    expect(() =>
      parse({
        ...motionLight,
        triggers: [
          { kind: 'deviceState', target: { deviceIds: [motionId] }, path: 'sensors.mood', op: 'eq', value: 1 },
        ],
      }),
    ).toThrow();
    expect(() => parse({ ...motionLight, actions: [] })).toThrow();
  });

  it('refuses an interval faster than a minute', () => {
    expect(() => parse({ ...motionLight, triggers: [{ kind: 'interval', everyMs: 5_000 }] })).toThrow();
    expect(parse({ ...motionLight, triggers: [{ kind: 'interval', everyMs: 60_000 }] })).toBeTruthy();
  });

  it('refuses IR library management as an action, and allows replay', () => {
    const irId = randomUUID();
    const learn = {
      ...motionLight,
      actions: [
        { kind: 'deviceCommand', target: { deviceIds: [irId] }, command: { type: 'irLearn', on: true } },
      ],
    };
    expect(() => parse(learn)).toThrow();
    const send = {
      ...motionLight,
      actions: [
        {
          kind: 'deviceCommand',
          target: { deviceIds: [irId] },
          command: { type: 'irSend', commandId: 'tv-on' },
        },
      ],
    };
    expect(parse(send)).toBeTruthy();
  });

  it('tells a button from a toggle by whether it says what "off" does', () => {
    const button = parse({ ...motionLight, triggers: [{ kind: 'manual' }] });
    expect(isManual(button)).toBe(true);
    expect(isToggle(button)).toBe(false);

    const toggle = parse({
      ...motionLight,
      triggers: [{ kind: 'manual' }],
      offActions: [
        { kind: 'deviceCommand', target: { deviceIds: [ceilingLightId] }, command: { type: 'power', on: false } },
      ],
    });
    expect(isToggle(toggle)).toBe(true);
  });
});

// ── Targets ──────────────────────────────────────────────────────────────────

describe('resolving a target', () => {
  it('picks the endpoint that carries the capability, not the first one', () => {
    const [resolved] = resolveTarget({ deviceIds: [twoGangId] }, home(), { capability: 'level' });
    expect(resolved?.endpointId).toBe(2);
    // With nothing asked for, the first endpoint is the honest default.
    expect(resolveTarget({ deviceIds: [twoGangId] }, home())[0]?.endpointId).toBe(1);
  });

  it('drops a device that cannot carry the capability at all', () => {
    expect(resolveTarget({ deviceIds: [motionId] }, home(), { capability: 'onOff' })).toEqual([]);
  });

  it('selects by room, by zone and by capability', () => {
    const byRoom = resolveTarget({ select: { roomId: kitchenId, capability: 'onOff' } }, home());
    expect(byRoom.map((entry) => entry.deviceName).sort()).toEqual([
      'Ceiling light',
      'Hall switch',
      'Washing machine plug',
    ]);

    const byZone = resolveTarget({ select: { zoneId: upstairsId, kind: 'light' } }, home());
    expect(byZone.map((entry) => entry.deviceName)).toEqual(['Bedside lamp']);
  });

  it('keeps the order the author named devices in', () => {
    const named = resolveTarget({ deviceIds: [lampId, ceilingLightId] }, home());
    expect(named.map((entry) => entry.deviceName)).toEqual(['Bedside lamp', 'Ceiling light']);
  });

  it('caps the blast radius of a selector', () => {
    const many = home({
      devices: Array.from({ length: MAX_FAN_OUT + 10 }, (_, index) => ({
        id: randomUUID(),
        name: `Lamp ${index}`,
        roomId: kitchenId,
        online: true,
        endpoints: [{ endpointId: 1, deviceKind: 'light' as const, capabilities: ['onOff' as const] }],
      })),
    });
    expect(resolveTarget({ select: { capability: 'onOff' } }, many)).toHaveLength(MAX_FAN_OUT);
  });

  it('describes itself in words, for a trace a person reads', () => {
    expect(describeTarget({ deviceIds: [ceilingLightId, lampId] }, home())).toBe(
      'Ceiling light and Bedside lamp',
    );
    expect(describeTarget({ select: { kind: 'light', roomId: bedroomId } }, home())).toBe(
      'all the lights in Bedroom',
    );
  });

  it('names a set by its kind or its capability, in words, and never both', () => {
    // A `capability` is a schema token and this is a sentence somebody reads.
    // It used to be printed raw and *beside* the kind — "every lights with
    // onOff" — which is a field name read out loud on the one line both apps
    // put under a rule.
    expect(describeTarget({ select: { kind: 'light', capability: 'onOff' } }, home())).toBe(
      'all the lights',
    );
    expect(describeTarget({ select: { capability: 'doorLock' } }, home())).toBe('all the locks');
    expect(describeTarget({ select: { capability: 'battery' } }, home())).toBe(
      'all the devices with a battery',
    );
  });

  it('says "any" where the engine means any', () => {
    // Not a nicety: a `deviceState` trigger is evaluated per device and fires
    // the moment one of them crosses, so describing it as "all the temperature
    // sensors" claimed a rule waits for the whole house to reach 25 °C.
    expect(describeTarget({ select: { capability: 'temperature' } }, home(), 'any')).toBe(
      'any of the temperature sensors',
    );
  });
});

// ── The sentence both apps draw ──────────────────────────────────────────────

/**
 * `describeAutomation` is the **contract**: `HubAutomationDTO.summary` is
 * every rule row's subtitle and the whole body of its page, and it is what an
 * app a version behind draws instead of a blank card. It had no test, which is
 * how it came to print stored units at a person.
 */
describe('a rule in a sentence', () => {
  function summarize(document: unknown): string {
    return describeAutomation(automationDocumentSchema.parse(document), home());
  }

  it('says a stored number in the unit a person means by it', () => {
    // **Wrong by two orders of magnitude and reading perfectly** — the exact
    // failure the catalog warns the *agent* about, on the way back out.
    expect(
      summarize({
        name: 'Too warm',
        triggers: [
          {
            kind: 'deviceState',
            target: { select: { capability: 'temperature' } },
            path: 'sensors.temperatureCenti',
            op: 'gt',
            value: 2500,
            for: 60_000,
          },
        ],
        actions: [{ kind: 'logActivity', message: 'warm' }],
      }),
    ).toBe(
      'When the temperature on any of the temperature sensors goes above 25 °C for 1 minute: ' +
        'write a line in the history.',
    );
  });

  it('names the days rather than counting them', () => {
    expect(
      summarize({
        name: 'Morning',
        triggers: [{ kind: 'schedule', at: '07:00', days: [1, 2, 3, 4, 5] }],
        actions: [{ kind: 'logActivity', message: 'up' }],
      }),
    ).toBe('When it is 07:00 on weekdays: write a line in the history.');

    expect(
      summarize({
        name: 'Weekend',
        triggers: [{ kind: 'schedule', at: '09:30', days: [0, 6] }],
        actions: [{ kind: 'logActivity', message: 'lie in' }],
      }),
    ).toBe('When it is 09:30 on weekends: write a line in the history.');

    expect(
      summarize({
        name: 'Bins',
        triggers: [{ kind: 'schedule', at: '20:00', days: [2] }],
        actions: [{ kind: 'logActivity', message: 'bins' }],
      }),
    ).toBe('When it is 20:00 on Tuesday: write a line in the history.');
  });

  it('spells a duration out in the unit it was written in', () => {
    expect(
      summarize({
        name: 'Hall',
        triggers: [
          {
            kind: 'deviceState',
            target: { select: { capability: 'occupancy' } },
            path: 'sensors.occupied',
            op: 'eq',
            value: true,
          },
        ],
        actions: [
          { kind: 'wait', ms: 300_000 },
          { kind: 'logActivity', message: 'late' },
        ],
      }),
    ).toBe(
      'When any of the motion sensors sees somebody: wait 5 minutes, then write a line in the history.',
    );
  });

  it('puts a reading before its devices, and a state after them', () => {
    // Two shapes of path with opposite word orders: "the battery on any of …"
    // against "any of the motion sensors sees somebody". One order for both
    // named the subject twice.
    expect(
      summarize({
        name: 'Low battery',
        triggers: [
          {
            kind: 'deviceState',
            target: { select: { capability: 'battery' } },
            path: 'battery.percent',
            op: 'lt',
            value: 15,
            hysteresis: 5,
          },
        ],
        actions: [{ kind: 'logActivity', message: 'flat' }],
      }),
    ).toBe(
      'When the battery on any of the devices with a battery goes below 15%: ' +
        'write a line in the history.',
    );
  });
});

// ── The safety rule this module exists for ───────────────────────────────────

describe('a threshold on a continuously-varying reading', () => {
  const bare = {
    name: 'Washing machine finished',
    triggers: [
      {
        kind: 'deviceState',
        target: { deviceIds: [meterId] },
        path: 'power.activeMilliwatts',
        op: 'lt',
        value: 2_000,
      },
    ],
    actions: [{ kind: 'logActivity', message: 'Washing machine finished' }],
  };

  it('is refused without a hold or a hysteresis band', () => {
    const { problems } = sanityCheckAutomation(parse(bare), home());
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('changes continuously');
  });

  it('is accepted once it has to hold', () => {
    const held = structuredClone(bare) as typeof bare & { triggers: Array<Record<string, unknown>> };
    held.triggers[0]!.for = MIN_HOLD_MS;
    expect(sanityCheckAutomation(parse(held), home()).problems).toEqual([]);
  });

  it('is accepted with a hysteresis band instead', () => {
    const banded = structuredClone(bare) as typeof bare & { triggers: Array<Record<string, unknown>> };
    banded.triggers[0]!.hysteresis = 500;
    expect(sanityCheckAutomation(parse(banded), home()).problems).toEqual([]);
  });

  it('does not ask the same of a value that only moves when something moves it', () => {
    // `level.current` changes because somebody dimmed a lamp, not because a
    // reading wobbled — so a bare threshold on it is a statement about an
    // action and needs no hold.
    const doc = parse({
      ...bare,
      triggers: [
        { kind: 'deviceState', target: { deviceIds: [lampId] }, path: 'level.current', op: 'gt', value: 200 },
      ],
    });
    expect(sanityCheckAutomation(doc, home()).problems).toEqual([]);
  });
});

// ── Comparisons ──────────────────────────────────────────────────────────────

describe('comparisons', () => {
  const withTrigger = (trigger: Record<string, unknown>) =>
    parse({ ...motionLight, triggers: [trigger] });

  it('refuses an ordering test on a true/false value', () => {
    const { problems } = sanityCheckAutomation(
      withTrigger({
        kind: 'deviceState',
        target: { deviceIds: [motionId] },
        path: 'sensors.occupied',
        op: 'gt',
        value: 1,
      }),
      home(),
    );
    expect(problems.join(' ')).toContain('says nothing about it');
  });

  it('refuses a value of the wrong type', () => {
    const { problems } = sanityCheckAutomation(
      withTrigger({
        kind: 'deviceState',
        target: { deviceIds: [meterId] },
        path: 'power.activeMilliwatts',
        op: 'eq',
        value: true,
      }),
      home(),
    );
    expect(problems.join(' ')).toContain('is a number');
  });

  it('refuses "changed" with a value, and a comparison without one', () => {
    expect(
      sanityCheckAutomation(
        withTrigger({
          kind: 'deviceState',
          target: { deviceIds: [lockId] },
          path: 'lock',
          op: 'changed',
          value: 1,
        }),
        home(),
      ).problems.join(' '),
    ).toContain('compares against nothing');

    expect(
      sanityCheckAutomation(
        withTrigger({ kind: 'deviceState', target: { deviceIds: [lockId] }, path: 'lock', op: 'eq' }),
        home(),
      ).problems.join(' '),
    ).toContain('needs a value');
  });

  it('refuses "changed" as a condition, where it could never be true', () => {
    const doc = parse({
      ...motionLight,
      conditions: [
        { kind: 'deviceState', target: { deviceIds: [lockId] }, path: 'lock', op: 'changed' },
      ],
    });
    expect(sanityCheckAutomation(doc, home()).problems.join(' ')).toContain('is a trigger, not a condition');
  });
});

// ── Pointing at real things ──────────────────────────────────────────────────

describe('what a rule points at', () => {
  it('refuses named devices that are not in the home', () => {
    const doc = parse({
      ...motionLight,
      actions: [
        { kind: 'deviceCommand', target: { deviceIds: [randomUUID()] }, command: { type: 'power', on: true } },
      ],
    });
    expect(sanityCheckAutomation(doc, home()).problems.join(' ')).toContain(
      'none of the named devices are in this home',
    );
  });

  it('only warns when a selector matches nothing yet', () => {
    // The shape every shipped template has before anybody pairs a device.
    const doc = parse({
      ...motionLight,
      actions: [
        {
          kind: 'deviceCommand',
          target: { select: { kind: 'vacuum' } },
          command: { type: 'power', on: true },
        },
      ],
    });
    const report = sanityCheckAutomation(doc, home());
    expect(report.problems).toEqual([]);
    expect(report.warnings.join(' ')).toContain('matches nothing in this home yet');
  });

  it('refuses a command nothing matched can honour', () => {
    const doc = parse({
      ...motionLight,
      actions: [
        {
          kind: 'deviceCommand',
          target: { deviceIds: [motionId] },
          command: { type: 'setLevel', level: 100 },
        },
      ],
    });
    expect(sanityCheckAutomation(doc, home()).problems.join(' ')).toContain('has no level');
  });

  it('warns when only some of a selector can honour it', () => {
    const doc = parse({
      ...motionLight,
      actions: [
        {
          kind: 'deviceCommand',
          target: { select: { roomId: kitchenId } },
          command: { type: 'setLevel', level: 100 },
        },
      ],
    });
    const report = sanityCheckAutomation(doc, home());
    expect(report.problems).toEqual([]);
    expect(report.warnings.join(' ')).toContain('will be skipped');
  });

  it('refuses a button trigger on something with no buttons', () => {
    const doc = parse({
      ...motionLight,
      triggers: [{ kind: 'deviceEvent', target: { deviceIds: [lampId] } }],
    });
    expect(sanityCheckAutomation(doc, home()).problems.join(' ')).toContain('can never fire');
  });

  it('accepts a button trigger on a remote', () => {
    const doc = parse({
      ...motionLight,
      triggers: [{ kind: 'deviceEvent', target: { deviceIds: [buttonId] }, gesture: 'single' }],
    });
    expect(sanityCheckAutomation(doc, home()).problems).toEqual([]);
  });
});

// ── Self-reference and shape ─────────────────────────────────────────────────

describe('shape', () => {
  const selfId = randomUUID();

  it('refuses a rule that runs itself, and allows one that switches itself off', () => {
    const loop = parse({
      ...motionLight,
      actions: [{ kind: 'runAutomation', automationId: selfId }],
    });
    expect(sanityCheckAutomation(loop, home(), { selfId }).problems.join(' ')).toContain('never stops');

    const once = parse({
      ...motionLight,
      actions: [
        { kind: 'deviceCommand', target: { deviceIds: [ceilingLightId] }, command: { type: 'power', on: true } },
        { kind: 'setAutomationEnabled', automationId: selfId, enabled: false },
      ],
    });
    expect(sanityCheckAutomation(once, home(), { selfId }).problems).toEqual([]);
  });

  it('refuses offActions with nothing to press', () => {
    const doc = parse({
      ...motionLight,
      offActions: [
        { kind: 'deviceCommand', target: { deviceIds: [ceilingLightId] }, command: { type: 'power', on: false } },
      ],
    });
    expect(sanityCheckAutomation(doc, home()).problems.join(' ')).toContain('manual trigger');
  });

  it('refuses a rule made only of waits', () => {
    const doc = parse({ ...motionLight, actions: [{ kind: 'wait', ms: 1_000 }] });
    expect(sanityCheckAutomation(doc, home()).problems.join(' ')).toContain('does nothing');
  });
});

// ── Loops ────────────────────────────────────────────────────────────────────

describe('loop detection', () => {
  it('warns when a rule writes to a device it also watches', () => {
    const doc = parse({
      name: 'Dim on switch-on',
      triggers: [
        { kind: 'deviceState', target: { deviceIds: [lampId] }, path: 'onOff', op: 'eq', value: true },
      ],
      actions: [
        { kind: 'deviceCommand', target: { deviceIds: [lampId] }, command: { type: 'setLevel', level: 90 } },
      ],
    });
    const report = sanityCheckAutomation(doc, home());
    // A warning, not a refusal: "when the lamp goes on, set it to 40%" is a
    // legitimate version of exactly this shape.
    expect(report.problems).toEqual([]);
    expect(report.warnings.join(' ')).toContain('which it also watches');
  });

  it('warns when two rules keep each other going', () => {
    const otherId = randomUUID();
    const other = parse({
      name: 'Lamp follows the ceiling',
      triggers: [
        { kind: 'deviceState', target: { deviceIds: [ceilingLightId] }, path: 'onOff', op: 'changed' },
      ],
      actions: [
        { kind: 'deviceCommand', target: { deviceIds: [lampId] }, command: { type: 'power', on: true } },
      ],
    });
    const withOther = home({
      automations: [{ id: otherId, name: 'Lamp follows the ceiling', enabled: true, document: other }],
    });

    const mine = parse({
      name: 'Ceiling follows the lamp',
      triggers: [{ kind: 'deviceState', target: { deviceIds: [lampId] }, path: 'onOff', op: 'changed' }],
      actions: [
        { kind: 'deviceCommand', target: { deviceIds: [ceilingLightId] }, command: { type: 'power', on: true } },
      ],
    });
    const report = sanityCheckAutomation(mine, withOther, { selfId: randomUUID() });
    expect(report.problems).toEqual([]);
    expect(report.warnings.join(' ')).toContain('That is a loop unless a condition breaks it');
  });

  it('says nothing about a rule that only reads one device and writes another', () => {
    expect(sanityCheckAutomation(parse(motionLight), home()).warnings).toEqual([]);
  });

  it('ignores a disabled rule when looking for a loop', () => {
    const otherId = randomUUID();
    const other = parse({
      name: 'Disabled counterpart',
      triggers: [
        { kind: 'deviceState', target: { deviceIds: [ceilingLightId] }, path: 'onOff', op: 'changed' },
      ],
      actions: [
        { kind: 'deviceCommand', target: { deviceIds: [lampId] }, command: { type: 'power', on: true } },
      ],
    });
    const withDisabled = home({
      automations: [{ id: otherId, name: 'Disabled counterpart', enabled: false, document: other }],
    });
    const mine = parse({
      name: 'Ceiling follows the lamp',
      triggers: [{ kind: 'deviceState', target: { deviceIds: [lampId] }, path: 'onOff', op: 'changed' }],
      actions: [
        { kind: 'deviceCommand', target: { deviceIds: [ceilingLightId] }, command: { type: 'power', on: true } },
      ],
    });
    expect(sanityCheckAutomation(mine, withDisabled, { selfId: randomUUID() }).warnings).toEqual([]);
  });
});

// ── The generated catalog ────────────────────────────────────────────────────

describe('the capability catalog', () => {
  it('is generated from the live schema rather than written out', () => {
    const catalog = automationCatalog();
    // If a trigger kind is added to the schema and not here, this is what
    // notices — the drift the catalog exists to prevent.
    expect(catalog.triggers.map((entry) => entry.id).sort()).toEqual([
      'deviceEvent',
      'deviceState',
      'interval',
      'manual',
      'schedule',
    ]);
    expect(catalog.schema).toHaveProperty('properties.triggers');
    expect(catalog.bounds.minHoldMs).toBe(MIN_HOLD_MS);
    // Every readable path reaches the catalog: a path added to the schema and
    // left out of the reference is one the agent never learns exists.
    expect(catalog.paths.length).toBe(Object.keys(READABLE_PATHS).length);
  });

  it('says which readings vary continuously, and in what units', () => {
    const catalog = automationCatalog();
    const power = catalog.paths.find((entry) => entry.id === 'power.activeMilliwatts');
    expect(power?.continuous).toBe(true);
    expect(power?.unit).toContain('milliwatts');

    // The two units most likely to be got wrong by a factor of a hundred, and
    // the one whose zero means the opposite of what it looks like.
    expect(catalog.paths.find((entry) => entry.id === 'sensors.temperatureCenti')?.unit).toContain(
      'hundredths',
    );
    expect(
      catalog.paths.find((entry) => entry.id === 'covering.currentPositionLiftPercent100ths')?.unit,
    ).toContain('0 is fully OPEN');
  });

  it('renders as a prompt that names the limits it enforces', () => {
    const prompt = catalogAsPrompt();
    expect(prompt).toContain('fires on the CROSSING');
    expect(prompt).toContain('0 is fully OPEN');
    expect(prompt).toContain('does not survive a restart');
  });
});

// ── The shipped templates ────────────────────────────────────────────────────

describe('templates', () => {
  const inputsFor = (template: (typeof AUTOMATION_TEMPLATES)[number]): Record<string, string> => {
    const values: Record<string, string> = {};
    for (const input of template.inputs) {
      if (input.kind === 'room') values[input.key] = kitchenId;
      if (input.kind === 'time') values[input.key] = input.default ?? '07:00';
      if (input.kind === 'device') values[input.key] = ceilingLightId;
    }
    return values;
  };

  it('every shipped template builds documents the schema accepts', () => {
    for (const template of AUTOMATION_TEMPLATES) {
      const documents = template.build(inputsFor(template));
      expect(documents.length).toBeGreaterThan(0);
      for (const document of documents) {
        expect(document.version).toBe(1);
        expect(() => automationDocumentSchema.parse(document)).not.toThrow();
      }
    }
  });

  it('every shipped template is sane in a home that has the devices', () => {
    for (const template of AUTOMATION_TEMPLATES) {
      for (const document of template.build(inputsFor(template))) {
        const report = sanityCheckAutomation(document, home());
        expect({ template: template.key, problems: report.problems }).toEqual({
          template: template.key,
          problems: [],
        });
      }
    }
  });

  it('installs into an empty home without refusing — selectors are why', () => {
    // The case the selectors exist for: a template written months before it
    // meets a home, installed the day the hub is claimed and nothing paired.
    const bare = home({ devices: [], rooms: [], zones: [] });
    for (const template of AUTOMATION_TEMPLATES) {
      if (template.inputs.some((input) => input.kind === 'room')) continue;
      for (const document of template.build(inputsFor(template))) {
        expect(sanityCheckAutomation(document, bare).problems).toEqual([]);
      }
    }
  });

  it('makes Night a toggle and I’m leaving a button', () => {
    const night = findTemplate('night')!.build({})[0]!;
    expect(isToggle(night)).toBe(true);

    const away = findTemplate('away')!.build({})[0]!;
    expect(isManual(away)).toBe(true);
    expect(isToggle(away)).toBe(false);
  });

  it('never unlocks anything on the way out of a mode', () => {
    // Deliberate: a rule that opens the house because somebody tapped a card
    // is not a convenience, and an action list cannot ask "are you sure".
    for (const template of AUTOMATION_TEMPLATES) {
      for (const document of template.build(inputsFor(template))) {
        const unlocks = [...document.actions, ...(document.offActions ?? [])].some(
          (action) =>
            action.kind === 'deviceCommand' &&
            action.command.type === 'lock' &&
            action.command.engage === false,
        );
        expect({ template: template.key, unlocks }).toEqual({ template: template.key, unlocks: false });
      }
    }
  });

  it('splits "light on movement" into the two rules it really is', () => {
    const documents = findTemplate('motion_light')!.build({ roomId: kitchenId });
    expect(documents).toHaveLength(2);
    // The off-rule waits, because a PIR clears the moment nobody moves and a
    // room going dark around somebody reading is why people give up on this.
    const off = documents[1]!;
    expect(off.triggers[0]).toMatchObject({ kind: 'deviceState', for: 5 * 60_000 });
  });
});
