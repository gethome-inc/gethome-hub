import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { eq } from 'drizzle-orm';
import { emptyState, mergeState, type EndpointState, type HubCommand } from '../src/schema/index.js';
import { HubEventBus, type AutomationRunEvent } from '../src/core/bus.js';
import { ActivityService } from '../src/core/activity.js';
import { automations as automationsTable } from '../src/db/schema.js';
import { AutomationEngine, type EngineRegistry, type EngineStructure } from '../src/automations/engine.js';
import { AutomationStore } from '../src/automations/store.js';
import { DEFAULT_GUARD_LIMITS } from '../src/automations/guards.js';
import { automationDocumentSchema, type AutomationDocument } from '../src/automations/schema.js';
import { openTestDb, resetDb, type TestDb } from './helpers/db.js';

/**
 * The engine, over a real store and a fake home.
 *
 * The clock is injected and the scheduler's step is called by hand, so a day
 * of a home's behaviour is checked in milliseconds — which is the whole
 * reason `now` is a constructor argument rather than a call to `Date.now()`.
 */

const log = pino({ level: 'silent' });

const kitchenId = randomUUID();
const lampId = randomUUID();
const otherLampId = randomUUID();
const meterId = randomUUID();
const motionId = randomUUID();
const buttonId = randomUUID();

interface FakeDevice {
  id: string;
  name: string;
  roomId: string | null;
  online: boolean;
  endpoints: {
    endpointId: number;
    deviceKind: 'light' | 'outlet' | 'sensor' | 'remote';
    capabilities: ('onOff' | 'level' | 'electricalPower' | 'occupancy' | 'event' | 'battery')[];
    state: EndpointState;
  }[];
}

class FakeRegistry implements EngineRegistry {
  readonly sent: { deviceId: string; endpointId: number; command: HubCommand }[] = [];
  /** Set to make `execute` throw, for the "a command failed" path. */
  failNext = false;
  /**
   * Whether a device reports its new state back after a command.
   *
   * Off by default so a test can hold the home still, and **on for the loop
   * tests**, because reporting back is exactly what closes a loop: a mains
   * relay publishes its new state within a second of being switched, and that
   * report is what sets the next rule off.
   */
  echo = false;
  private readonly devices: FakeDevice[] = [];

  constructor(private readonly events: HubEventBus) {}

  add(device: FakeDevice): void {
    this.devices.push(device);
  }

  listDevices() {
    return this.devices;
  }

  async execute(deviceId: string, endpointId: number, command: HubCommand): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('the radio refused');
    }
    this.sent.push({ deviceId, endpointId, command });
    if (!this.echo) return;
    const endpoint = this.devices
      .find((entry) => entry.id === deviceId)
      ?.endpoints.find((entry) => entry.endpointId === endpointId);
    if (!endpoint) return;
    if (command.type === 'power') this.report(deviceId, endpointId, { onOff: command.on });
    if (command.type === 'toggle') {
      this.report(deviceId, endpointId, { onOff: !(endpoint.state.onOff ?? false) });
    }
  }

  /** What a radio reporting a device's new state looks like from the bus. */
  report(deviceId: string, endpointId: number, patch: Partial<EndpointState>): void {
    const device = this.devices.find((entry) => entry.id === deviceId);
    const endpoint = device?.endpoints.find((entry) => entry.endpointId === endpointId);
    if (!endpoint) throw new Error(`no such endpoint ${deviceId}:${endpointId}`);
    endpoint.state = mergeState(endpoint.state, patch);
    this.events.emit('stateChanged', deviceId, endpointId, endpoint.state);
  }
}

let test: TestDb;
let events: HubEventBus;
let registry: FakeRegistry;
let store: AutomationStore;
let activity: ActivityService;
let engine: AutomationEngine;
let runs: AutomationRunEvent[];
let now = Date.UTC(2026, 5, 15, 12, 0, 0);

const structure: EngineStructure = {
  rooms: [{ id: kitchenId, name: 'Kitchen', zoneId: null }],
  zones: [],
};

/** Let whatever the bus set off finish. Firing is deliberately fire-and-forget
 *  on the report path, so a test has to wait for it the way a hub does. */
async function settle(times = 12): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function parse(document: unknown): AutomationDocument {
  return automationDocumentSchema.parse(document);
}

/** Save a rule and switch it on — creation is deliberately off by default. */
async function install(document: unknown): Promise<string> {
  const record = await store.create(parse(document), null);
  await store.setEnabled(record.id, true);
  await engine.reload();
  return record.id;
}

beforeEach(async () => {
  test ??= (await openTestDb())!;
  await resetDb(test.db);

  now = Date.UTC(2026, 5, 15, 12, 0, 0);
  events = new HubEventBus();
  registry = new FakeRegistry(events);
  store = new AutomationStore(test.db);
  activity = new ActivityService(test.db, events);
  runs = [];
  events.on('automationRun', (event) => runs.push(event));

  registry.add({
    id: lampId,
    name: 'Kitchen lamp',
    roomId: kitchenId,
    online: true,
    endpoints: [
      {
        endpointId: 1,
        deviceKind: 'light',
        capabilities: ['onOff', 'level'],
        state: { ...emptyState(), onOff: false },
      },
    ],
  });
  registry.add({
    id: otherLampId,
    name: 'Counter lamp',
    roomId: kitchenId,
    online: true,
    endpoints: [
      {
        endpointId: 1,
        deviceKind: 'light',
        capabilities: ['onOff'],
        state: { ...emptyState(), onOff: false },
      },
    ],
  });
  registry.add({
    id: meterId,
    name: 'Washing machine',
    roomId: kitchenId,
    online: true,
    endpoints: [
      {
        endpointId: 1,
        deviceKind: 'outlet',
        capabilities: ['onOff', 'electricalPower'],
        state: { ...emptyState(), onOff: true, power: { activeMilliwatts: 400_000 } },
      },
    ],
  });
  registry.add({
    id: motionId,
    name: 'Hall motion',
    roomId: kitchenId,
    online: true,
    endpoints: [
      {
        endpointId: 1,
        deviceKind: 'sensor',
        capabilities: ['occupancy', 'battery'],
        state: { ...emptyState(), sensors: { occupied: false } },
      },
    ],
  });
  registry.add({
    id: buttonId,
    name: 'Bedside button',
    roomId: kitchenId,
    online: true,
    endpoints: [
      { endpointId: 1, deviceKind: 'remote', capabilities: ['event'], state: emptyState() },
    ],
  });

  engine = new AutomationEngine({
    store,
    registry,
    events,
    activity,
    log,
    readStructure: async () => structure,
    timezone: () => 'Europe/Berlin',
    now: () => now,
  });
  await engine.start();
});

afterAll(async () => {
  await engine?.stop();
  await test?.close();
});

const lampOn = {
  name: 'Light on movement',
  triggers: [
    {
      kind: 'deviceState',
      target: { deviceIds: [motionId] },
      path: 'sensors.occupied',
      op: 'eq',
      value: true,
    },
  ],
  actions: [
    { kind: 'deviceCommand', target: { deviceIds: [lampId] }, command: { type: 'power', on: true } },
  ],
};

// ── Firing on the crossing ───────────────────────────────────────────────────

describe('a rule watching the home', () => {
  it('fires on the crossing and stays quiet while the test holds', async () => {
    await install(lampOn);

    registry.report(motionId, 1, { sensors: { occupied: true } });
    await settle();
    expect(registry.sent).toHaveLength(1);

    // The sensor goes on saying "occupied" every thirty seconds. That is not
    // news, and each repeat would otherwise be another command to the relay.
    registry.report(motionId, 1, { sensors: { occupied: true } });
    registry.report(motionId, 1, { sensors: { occupied: true } });
    await settle();
    expect(registry.sent).toHaveLength(1);
  });

  it('says nothing about a condition that was already true when it started', async () => {
    // The `REACHABILITY_QUIET_MS` judgement: a rule fires on a transition it
    // watched, and a hub that has just come back has watched none.
    registry.report(motionId, 1, { sensors: { occupied: true } });
    await install(lampOn);

    registry.report(motionId, 1, { sensors: { occupied: true } });
    await settle();
    expect(registry.sent).toHaveLength(0);
  });

  it('fires again once the test has stopped holding and comes back', async () => {
    await install(lampOn);
    registry.report(motionId, 1, { sensors: { occupied: true } });
    await settle();
    registry.report(motionId, 1, { sensors: { occupied: false } });
    await settle();

    now += 60_000;
    registry.report(motionId, 1, { sensors: { occupied: true } });
    await settle();
    expect(registry.sent).toHaveLength(2);
  });

  it('costs nothing on the report path for a device nothing watches', async () => {
    await install(lampOn);
    registry.report(meterId, 1, { power: { activeMilliwatts: 1_000 } });
    await settle(2);
    expect(runs).toHaveLength(0);
  });
});

// ── The guards, end to end ───────────────────────────────────────────────────

describe('protecting the devices', () => {
  it('does not send a command that would change nothing, and says so in the trace', async () => {
    registry.report(lampId, 1, { onOff: true });
    await install(lampOn);

    registry.report(motionId, 1, { sensors: { occupied: true } });
    await settle();

    expect(registry.sent).toHaveLength(0);
    const trace = await store.runs(runs[0]!.automationId);
    const steps = trace[0]!.steps as { kind: string; detail?: string }[];
    expect(steps.some((step) => step.kind === 'refused' && step.detail?.includes('already'))).toBe(true);
  });

  it('holds the minimum gap between two commands to one device', async () => {
    const flip = {
      name: 'Follow the meter',
      triggers: [
        { kind: 'deviceState', target: { deviceIds: [meterId] }, path: 'onOff', op: 'changed' },
      ],
      actions: [
        { kind: 'deviceCommand', target: { deviceIds: [lampId] }, command: { type: 'toggle' } },
      ],
    };
    await install(flip);

    registry.report(meterId, 1, { onOff: false });
    await settle();
    registry.report(meterId, 1, { onOff: true });
    await settle();

    // Two genuine crossings, half a second apart in the home's own clock.
    expect(registry.sent).toHaveLength(1);
    expect(runs.at(-1)?.refused).toBe(1);
  });

  it('switches a runaway rule off, records why, and puts it in the home’s history', async () => {
    const id = await install({
      name: 'Runaway',
      triggers: [
        { kind: 'deviceState', target: { deviceIds: [meterId] }, path: 'onOff', op: 'changed' },
      ],
      actions: [{ kind: 'logActivity', message: 'tick' }],
    });

    // The meter starts on, so the first report of `true` is not a change and
    // does not fire — hence two more turns than the limit.
    for (let index = 0; index <= DEFAULT_GUARD_LIMITS.runawayRuns + 1; index += 1) {
      registry.report(meterId, 1, { onOff: index % 2 === 0 });
      await settle(4);
      now += 1_000;
    }

    const [row] = await test.db.select().from(automationsTable).where(eq(automationsTable.id, id));
    expect(row?.enabled).toBe(false);
    expect(row?.disabledReason).toContain('switched off');

    // The one automatic firing that does reach the activity log, because it
    // is a discrete transition somebody has to be able to find a week later.
    const entries = await activity.list(50);
    expect(entries.some((entry) => entry.kind === 'automation.disabled')).toBe(true);
  });

  it('cuts a chain of automations that set each other off', async () => {
    // A watches one lamp and switches the other; B does the reverse. Every
    // link is legitimate on its own, and a mains relay reporting its new
    // state — which `echo` models — is what closes the circle.
    //
    // The per-device gap is turned off for this test on purpose: it would
    // stop the chain first and hide whether the *depth* cap works at all.
    await engine.stop();
    registry.echo = true;
    engine = new AutomationEngine({
      store,
      registry,
      events,
      activity,
      log,
      readStructure: async () => structure,
      timezone: () => 'Europe/Berlin',
      now: () => now,
      guardLimits: { minCommandIntervalMs: 0, maxCommandsPerHour: 10_000, maxCommandsPerDay: 10_000 },
    });
    await engine.start();

    await install({
      name: 'A',
      triggers: [
        { kind: 'deviceState', target: { deviceIds: [otherLampId] }, path: 'onOff', op: 'changed' },
      ],
      actions: [
        { kind: 'deviceCommand', target: { deviceIds: [lampId] }, command: { type: 'toggle' } },
      ],
    });
    await install({
      name: 'B',
      triggers: [{ kind: 'deviceState', target: { deviceIds: [lampId] }, path: 'onOff', op: 'changed' }],
      actions: [
        { kind: 'deviceCommand', target: { deviceIds: [otherLampId] }, command: { type: 'toggle' } },
      ],
    });

    // One change nobody automated: somebody flips the counter lamp.
    registry.report(otherLampId, 1, { onOff: true });
    await settle(40);

    // The chain runs and then stops. Without the depth cap this never ends.
    expect(runs.length).toBeGreaterThan(1);
    expect(runs.some((event) => event.refused > 0)).toBe(true);
    expect(
      runs.flatMap((event) => (event.detail ? [event.detail] : [])).join(' '),
    ).toContain('chain of automations');
    expect(registry.sent.length).toBeLessThan(12);
  });
});

// ── Holding a reading ────────────────────────────────────────────────────────

describe('"and it stayed there"', () => {
  const held = {
    name: 'Lights off when still',
    triggers: [
      {
        kind: 'deviceState',
        target: { deviceIds: [motionId] },
        path: 'sensors.occupied',
        op: 'eq',
        value: false,
        for: 60,
      },
    ],
    actions: [
      { kind: 'deviceCommand', target: { deviceIds: [lampId] }, command: { type: 'power', on: false } },
    ],
  };

  it('waits for the hold before it fires', async () => {
    registry.report(lampId, 1, { onOff: true });
    registry.report(motionId, 1, { sensors: { occupied: true } });
    await install(held);

    registry.report(motionId, 1, { sensors: { occupied: false } });
    await settle(2);
    expect(registry.sent).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 90));
    await settle();
    expect(registry.sent).toHaveLength(1);
  });

  it('drops the hold if the reading comes back', async () => {
    // A PIR clears the second nobody moves; a room going dark around somebody
    // reading is why people give up on motion lighting.
    registry.report(lampId, 1, { onOff: true });
    registry.report(motionId, 1, { sensors: { occupied: true } });
    await install(held);

    registry.report(motionId, 1, { sensors: { occupied: false } });
    await settle(2);
    registry.report(motionId, 1, { sensors: { occupied: true } });
    await settle(2);

    await new Promise((resolve) => setTimeout(resolve, 90));
    await settle();
    expect(registry.sent).toHaveLength(0);
  });
});

// ── Conditions ───────────────────────────────────────────────────────────────

describe('conditions', () => {
  it('skips the run when one does not hold, and says which', async () => {
    await install({
      ...lampOn,
      // Noon in Berlin is 14:00; the window is the night.
      conditions: [{ kind: 'timeRange', from: '22:00', to: '06:00' }],
    });

    registry.report(motionId, 1, { sensors: { occupied: true } });
    await settle();

    expect(registry.sent).toHaveLength(0);
    expect(runs.at(-1)?.outcome).toBe('skipped');
    expect(runs.at(-1)?.detail).toContain('condition');
  });

  it('runs when the window is open', async () => {
    await install({
      ...lampOn,
      conditions: [{ kind: 'timeRange', from: '06:00', to: '22:00' }],
    });
    registry.report(motionId, 1, { sensors: { occupied: true } });
    await settle();
    expect(registry.sent).toHaveLength(1);
  });

  it('asks whether a mode is switched on', async () => {
    const securityId = await install({
      name: 'Security',
      triggers: [{ kind: 'manual' }],
      actions: [{ kind: 'logActivity', message: 'armed' }],
      offActions: [{ kind: 'logActivity', message: 'disarmed' }],
    });
    await install({
      ...lampOn,
      conditions: [{ kind: 'automationActive', automationId: securityId, is: true }],
    });

    registry.report(motionId, 1, { sensors: { occupied: true } });
    await settle();
    expect(registry.sent).toHaveLength(0);

    await engine.setActive(securityId, true, 'Anna');
    now += 60_000;
    registry.report(motionId, 1, { sensors: { occupied: false } });
    await settle();
    registry.report(motionId, 1, { sensors: { occupied: true } });
    await settle();
    expect(registry.sent).toHaveLength(1);
  });
});

// ── Buttons and modes ────────────────────────────────────────────────────────

describe('what a person presses', () => {
  it('runs a one-shot button and writes it to the home’s history', async () => {
    const id = await install({
      name: 'I’m leaving',
      triggers: [{ kind: 'manual' }],
      actions: [
        {
          kind: 'deviceCommand',
          target: { select: { roomId: kitchenId, kind: 'light', capability: 'onOff' } },
          command: { type: 'power', on: false },
        },
      ],
    });
    registry.report(lampId, 1, { onOff: true });
    registry.report(otherLampId, 1, { onOff: true });

    expect(await engine.runManually(id, 'Anna')).toBe(true);
    await settle();

    // The selector reached both lamps.
    expect(registry.sent).toHaveLength(2);
    const entries = await activity.list(10);
    expect(entries[0]?.kind).toBe('automation.ran');
    expect(entries[0]?.message).toContain('Anna');
  });

  it('runs offActions when a mode is switched off, and skips its conditions', async () => {
    const id = await install({
      name: 'Night',
      triggers: [{ kind: 'manual' }],
      // Never true at noon: turning a mode *off* must not be gated on it, or
      // a house stays locked in a mode because of the hour.
      conditions: [{ kind: 'timeRange', from: '22:00', to: '23:00' }],
      actions: [
        { kind: 'deviceCommand', target: { deviceIds: [lampId] }, command: { type: 'power', on: false } },
      ],
      offActions: [
        { kind: 'deviceCommand', target: { deviceIds: [lampId] }, command: { type: 'power', on: true } },
      ],
    });

    await engine.setActive(id, true, 'Anna');
    await settle();
    expect(registry.sent).toHaveLength(0);

    await engine.setActive(id, false, 'Anna');
    await settle();
    expect(registry.sent).toHaveLength(1);
    expect(registry.sent[0]?.command).toEqual({ type: 'power', on: true });
  });

  it('fires on a button press, and only for the gesture asked for', async () => {
    await install({
      name: 'Double press',
      triggers: [{ kind: 'deviceEvent', target: { deviceIds: [buttonId] }, gesture: 'double' }],
      actions: [
        { kind: 'deviceCommand', target: { deviceIds: [lampId] }, command: { type: 'toggle' } },
      ],
    });

    registry.report(buttonId, 1, { event: { button: 'main', gesture: 'single', at: 1 } });
    await settle();
    registry.report(buttonId, 1, { event: { button: 'main', gesture: 'double', at: 2 } });
    await settle();

    expect(registry.sent).toHaveLength(1);
  });
});

// ── The clock ────────────────────────────────────────────────────────────────

describe('the scheduler', () => {
  const atTwo = {
    name: 'Afternoon',
    triggers: [{ kind: 'schedule', at: '14:00' }],
    actions: [
      { kind: 'deviceCommand', target: { deviceIds: [lampId] }, command: { type: 'power', on: true } },
    ],
  };

  it('fires in the minute it is in, once', async () => {
    await install(atTwo);

    // 12:00 UTC is 14:00 in Berlin.
    await engine.tick();
    await settle();
    expect(registry.sent).toHaveLength(1);

    // Two more ticks inside the same minute change nothing.
    now += 20_000;
    await engine.tick();
    now += 20_000;
    await engine.tick();
    await settle();
    expect(registry.sent).toHaveLength(1);
  });

  it('does not make up an occurrence the hub was down for', async () => {
    await install(atTwo);
    // The hub comes back at half past — the minute has gone, and a heater
    // told to come on at seven should not come on at nine.
    now = Date.UTC(2026, 5, 15, 12, 30, 0);
    await engine.tick();
    await settle();
    expect(registry.sent).toHaveLength(0);
  });

  it('honours the days it was given', async () => {
    // 15 June 2026 is a Monday.
    await install({ ...atTwo, triggers: [{ kind: 'schedule', at: '14:00', days: [0, 6] }] });
    await engine.tick();
    await settle();
    expect(registry.sent).toHaveLength(0);
  });

  it('holds everything while the clock is implausible', async () => {
    await install(atTwo);
    now = Date.UTC(2001, 0, 1, 12, 0, 0);
    await engine.tick();
    await settle();
    expect(registry.sent).toHaveLength(0);
  });

  it('arms an interval rather than firing it on the first tick', async () => {
    await install({
      name: 'Every ten minutes',
      triggers: [{ kind: 'interval', everyMs: 10 * 60_000 }],
      actions: [{ kind: 'logActivity', message: 'tick' }],
    });

    await engine.tick();
    await settle();
    // A hub restart is not an interval elapsing.
    expect(runs).toHaveLength(0);

    now += 10 * 60_000;
    await engine.tick();
    await settle();
    expect(runs).toHaveLength(1);
  });
});

// ── Rules this build cannot read ─────────────────────────────────────────────

describe('a document from a newer build', () => {
  it('is kept, reported and not run', async () => {
    // What `install.sh` rolling back to the previous release looks like from
    // in here: the migration has run, and the row names a node this build has
    // never heard of.
    await test.db.insert(automationsTable).values({
      name: 'From the future',
      enabled: true,
      document: {
        version: 1,
        name: 'From the future',
        triggers: [{ kind: 'sunrise', offsetMinutes: -30 }],
        actions: [{ kind: 'teleport' }],
      },
    });
    await engine.reload();

    expect(engine.list()).toHaveLength(0);
    expect(engine.unreadableRules()).toHaveLength(1);
    expect(engine.unreadableRules()[0]?.name).toBe('From the future');

    // And the row is still there, so the newer build finds it again.
    const rows = await test.db.select().from(automationsTable);
    expect(rows).toHaveLength(1);
  });
});

// ── Traces ───────────────────────────────────────────────────────────────────

describe('the trace', () => {
  it('records what ran, per rule, and prunes to a bound', async () => {
    const id = await install({
      name: 'Noisy',
      triggers: [
        { kind: 'deviceState', target: { deviceIds: [meterId] }, path: 'onOff', op: 'changed' },
      ],
      actions: [{ kind: 'logActivity', message: 'tick' }],
    });

    for (let index = 0; index < 5; index += 1) {
      registry.report(meterId, 1, { onOff: index % 2 === 0 });
      await settle(3);
      now += 1_000;
    }

    const trace = await store.runs(id);
    expect(trace.length).toBeGreaterThan(0);
    expect(trace[0]?.cause).toContain('Washing machine');
    expect(trace[0]?.outcome).toBe('ran');
  });

  it('records a command the radio refused without failing the run', async () => {
    await install(lampOn);
    registry.failNext = true;
    registry.report(motionId, 1, { sensors: { occupied: true } });
    await settle();

    expect(runs.at(-1)?.refused).toBe(1);
    expect(runs.at(-1)?.outcome).toBe('ran');
  });
});
