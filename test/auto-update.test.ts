import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityService, type ActivityInput } from '../src/core/activity.js';
import {
  CI_MARGIN_MS,
  MAX_ATTEMPTS,
  SOAK_MS,
  createAutoUpdater,
  type AutoUpdater,
  type UpdateRuleView,
} from '../src/core/auto-update.js';
import { HubEventBus, type AutomationRunEvent } from '../src/core/bus.js';
import { DEFAULT_WINDOW_START, QuietHours, quietestStart } from '../src/core/quiet-hours.js';
import { SettingsService } from '../src/core/settings.js';
import type { HeadCommit } from '../src/core/update.js';
import { members } from '../src/db/schema.js';
import { openTestDb, resetDb, type TestDb } from './helpers/db.js';

/**
 * `core/quiet-hours.ts` and `core/auto-update.ts` — a hub that updates itself,
 * when its home has said it may, at an hour the home is quiet.
 *
 * Everything here is a decision about time, so the clock is injected and a
 * night is driven by setting it and calling `tick()`. What these pin is the
 * list of reasons a hub must *not* restart itself — somebody using the home, a
 * rule about to run, a build nobody has had a day to look at — because each of
 * them is a family's evening if it is wrong, and none of them is visible from
 * outside until it is.
 */

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const DAY = 24 * HOUR;
/** A Wednesday, at noon UTC. */
const NOON = Date.UTC(2026, 9, 21, 12, 0);
const BUILD = '0.1.0-aaaaaaa-main';
const silent = pino({ level: 'silent' });

let test: TestDb;
let events: HubEventBus;
let settings: SettingsService;
let activity: ActivityService;
let now: number;
let timezone: string;
let dataDir: string;
let busy: boolean;
let head: HeadCommit;
let fetches: number;
let nextId: number;
const updaters: AutoUpdater[] = [];

/** The rules, as the updater sees them: three answers a test sets directly. */
const rules: UpdateRuleView & { inFlight: boolean; due: boolean; hours: number[] } = {
  inFlight: false,
  due: false,
  hours: [] as number[],
  hasRunInFlight() {
    return this.inFlight;
  },
  scheduledWithin() {
    return this.due;
  },
  scheduledHours() {
    return this.hours;
  },
};

beforeEach(async () => {
  test ??= (await openTestDb())!;
  await resetDb(test.db);
  events = new HubEventBus();
  settings = new SettingsService(test.db, Buffer.alloc(32).toString('base64'));
  activity = new ActivityService(test.db, events);
  now = NOON;
  timezone = 'UTC';
  busy = false;
  rules.inFlight = false;
  rules.due = false;
  rules.hours = [];
  fetches = 0;
  nextId = 1;
  // Main's head, two days old: old enough to install, and not this hub's build.
  head = { sha: 'bbbbbbb', committedAt: NOON - 2 * DAY };
  dataDir = mkdtempSync(path.join(tmpdir(), 'gethome-auto-update-'));
  mkdirSync(path.join(dataDir, 'update'), { recursive: true });
  // The plumbing `install.sh` writes; without it nothing may be asked for.
  writeFileSync(path.join(dataDir, 'update', 'enabled'), '');
});

afterEach(async () => {
  while (updaters.length > 0) await updaters.pop()!.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

afterAll(async () => {
  await test?.close();
});

/** Somebody asked the hub for something, now. */
function asked(): void {
  events.emit('activity', {
    id: nextId++,
    at: new Date(now).toISOString(),
    kind: 'device.command',
    message: 'Anna switched the kitchen lamp on.',
    memberId: 'member-anna',
  });
}

/** A rule ran, now. */
function ran(trigger: string, outcome: AutomationRunEvent['outcome'] = 'ran', commands = 1): void {
  events.emit('automationRun', {
    automationId: 'rule-1',
    name: 'A rule',
    at: new Date(now).toISOString(),
    trigger,
    cause: 'because',
    outcome,
    commands,
    refused: 0,
  });
}

function quietHours(): QuietHours {
  return new QuietHours({ settings, events, activity, log: silent, now: () => now });
}

async function updater(
  options: { build?: string | undefined; recordRow?: (row: ActivityInput) => void } = {},
): Promise<AutoUpdater> {
  const made = createAutoUpdater({
    dataDir,
    build: 'build' in options ? options.build : BUILD,
    settings,
    timezone: () => timezone,
    activity: {
      lastAskedAt: () => activity.lastAskedAt(),
      record: async (row) => {
        options.recordRow?.(row);
        await activity.record(row);
      },
    },
    events,
    rules,
    busy: () => busy,
    log: silent,
    now: () => now,
    fetchHead: async () => {
      fetches += 1;
      return head;
    },
  });
  await made.load();
  made.start();
  updaters.push(made);
  return made;
}

const requestFile = (): string => path.join(dataDir, 'update', 'request');
const requested = (): string | undefined =>
  existsSync(requestFile()) ? readFileSync(requestFile(), 'utf8').trim() : undefined;

/** What the root runner does with a request: consume it, and write how it went. */
function runnerFinishes(state: 'succeeded' | 'rolled-back' | 'failed', liveBuild = BUILD): void {
  const id = requested();
  rmSync(requestFile(), { force: true });
  writeFileSync(
    path.join(dataDir, 'update', 'status.json'),
    JSON.stringify({
      id,
      state,
      step: 'done',
      startedAt: new Date(now).toISOString(),
      heartbeat: new Date(now).toISOString(),
      fromBuild: BUILD,
      hubAnswering: true,
      warnings: [],
      liveBuild,
      finishedAt: new Date(now).toISOString(),
    }),
  );
}

/** Ten past three in the morning, `days` after today — inside the default window. */
const tenPastThree = (days = 1): number => Date.UTC(2026, 9, 21 + days, 3, 10);

async function rows() {
  return activity.list(50);
}

// ── When the home is used ────────────────────────────────────────────────────

describe('when the home is used', () => {
  it('counts what a person asked for and what a rule did — nothing the hub says about itself', async () => {
    const quiet = quietHours();
    await quiet.load();
    quiet.start();
    await quiet.begin();

    asked();
    // The hub's own row: a device dropping off the network. Nobody asked.
    events.emit('activity', { id: nextId++, at: new Date(now).toISOString(), kind: 'device.offline', message: 'x' });
    ran('schedule');
    ran('schedule', 'skipped');
    ran('schedule', 'ran', 0);
    // A press arrives as its activity row too; counted once, not twice.
    ran('manual');
    await quiet.stop();

    const stored = await settings.get<{ hours: [number, number][] }>('update_rhythm');
    expect(stored?.hours).toEqual([[Math.floor(now / HOUR), 2]]);
  });

  it('records nothing while automatic updates are off, and still notices somebody', async () => {
    const quiet = quietHours();
    await quiet.load();
    quiet.start();
    asked();
    await quiet.stop();
    expect(await settings.get('update_rhythm')).toBeNull();
    expect(quiet.lastUseAt()).toBe(now);
  });

  it('reads a person, or a device setting a rule off, as somebody about — never the clock', async () => {
    const quiet = quietHours();
    await quiet.load();
    quiet.start();
    await quiet.begin();

    ran('schedule');
    ran('interval');
    expect(quiet.lastUseAt(), 'a rule the clock started is the home on its own').toBeUndefined();

    now += MINUTE;
    ran('deviceState');
    expect(quiet.lastUseAt()).toBe(now);

    now += MINUTE;
    asked();
    expect(quiet.lastUseAt()).toBe(now);
    await quiet.stop();
  });

  it('starts again from nothing each time it is switched on, and forgets when switched off', async () => {
    const quiet = quietHours();
    await quiet.load();
    quiet.start();
    await quiet.begin();
    asked();
    await quiet.flush();
    expect((await settings.get<{ hours: unknown[] }>('update_rhythm'))?.hours).toHaveLength(1);

    await quiet.end();
    expect(await settings.get('update_rhythm')).toBeNull();

    now += DAY;
    await quiet.begin();
    expect(await settings.get('update_rhythm')).toEqual({ v: 1, since: now, hours: [] });
    await quiet.stop();
  });

  it('keeps two weeks and no more', async () => {
    const quiet = quietHours();
    await quiet.load();
    quiet.start();
    await quiet.begin();
    asked();
    now += 15 * DAY;
    asked();
    await quiet.stop();
    expect((await settings.get<{ hours: [number, number][] }>('update_rhythm'))?.hours).toEqual([
      [Math.floor(now / HOUR), 1],
    ]);
  });

  it('counts nothing against a clock that has not been set', async () => {
    const quiet = quietHours();
    await quiet.load();
    quiet.start();
    await quiet.begin();
    now = Date.UTC(1970, 0, 1, 0, 0, 10);
    asked();
    await quiet.stop();
    expect((await settings.get<{ hours: unknown[] }>('update_rhythm'))?.hours).toEqual([]);
    expect(quiet.lastUseAt()).toBeUndefined();
  });

  it('remembers, across a restart, the last time somebody asked for anything', async () => {
    // The bus says nothing about the minutes before the process started, and on
    // the night of an update that is exactly the half hour that matters.
    const [member] = await test.db.insert(members).values({ name: 'Anna', role: 'owner' }).returning();
    await activity.record({ kind: 'device.command', message: 'Anna switched the lamp on.', memberId: member!.id });
    await activity.record({ kind: 'device.offline', message: 'The lamp dropped off the network.' });
    const quiet = quietHours();
    await quiet.load();
    expect(quiet.lastUseAt()).toBeGreaterThan(Date.now() - MINUTE);
  });
});

describe('the quiet window', () => {
  /** Drive `days` of a home busy every hour but `quiet`, three uses an hour. */
  async function learn(quiet: QuietHours, days: number, quietHoursUtc: readonly number[]): Promise<void> {
    const start = now;
    for (let day = 0; day < days; day++) {
      for (let hour = 0; hour < 24; hour++) {
        if (quietHoursUtc.includes(hour)) continue;
        now = start + day * DAY + hour * HOUR + 30 * MINUTE;
        asked();
        asked();
        asked();
      }
    }
    now = start + days * DAY;
  }

  async function begun(): Promise<QuietHours> {
    now = Date.UTC(2026, 9, 1, 0, 0);
    const quiet = quietHours();
    await quiet.load();
    quiet.start();
    await quiet.begin();
    return quiet;
  }

  it('is 03:00 to 05:00 until three days have been learned', async () => {
    const quiet = await begun();
    await learn(quiet, 2, [10, 11, 12]);
    expect(quiet.window('UTC')).toEqual({ startHour: DEFAULT_WINDOW_START, hours: 2, learned: false });
    await quiet.stop();
  });

  it('finds the hours this home is quiet in, wherever they are', async () => {
    // Somebody on nights: busy around the clock except late morning.
    const quiet = await begun();
    await learn(quiet, 4, [10, 11, 12]);
    // 10:00–12:00 and 11:00–13:00 score the same; the nearer to the night wins.
    expect(quiet.window('UTC')).toEqual({ startHour: 10, hours: 2, learned: true });
    await quiet.stop();
  });

  it('reads the counts in the home\'s own hours', async () => {
    // The same home in Moscow, three hours ahead of the UTC the buckets keep.
    const quiet = await begun();
    await learn(quiet, 4, [10, 11, 12]);
    expect(quiet.window('Europe/Moscow')).toEqual({ startHour: 13, hours: 2, learned: true });
    await quiet.stop();
  });

  it('keeps clear of the hour a rule is set to run in', async () => {
    const quiet = await begun();
    await learn(quiet, 4, Array.from({ length: 24 }, (_, hour) => hour));
    // Nothing used at all — but a rule at half past three every night.
    expect(quiet.window('UTC', [3]).startHour).toBe(5);
    await quiet.stop();
  });

  it('falls back to the night when the timezone is one nothing can read', async () => {
    const quiet = await begun();
    await learn(quiet, 4, [10, 11, 12]);
    expect(quiet.window('Not/AZone')).toEqual({ startHour: DEFAULT_WINDOW_START, hours: 2, learned: false });
    await quiet.stop();
  });

  it('gives a home that never uses the hub the default night', () => {
    expect(quietestStart(new Array<number>(24).fill(0))).toBe(DEFAULT_WINDOW_START);
  });
});

// ── The switch ───────────────────────────────────────────────────────────────

describe('automatic updates', () => {
  it('are off until somebody switches them on', async () => {
    const hub = await updater();
    expect(hub.describe()).toEqual({ enabled: false });
    now = tenPastThree();
    await hub.tick();
    expect(fetches).toBe(0);
    expect(requested()).toBeUndefined();
  });

  it('answer with the window they will use, and say it is not learned yet', async () => {
    const hub = await updater();
    const answer = await hub.setEnabled(true);
    expect(answer).toEqual({
      enabled: true,
      window: { from: '2026-10-22T03:00:00.000Z', to: '2026-10-22T05:00:00.000Z' },
      learned: false,
    });
  });

  it('put the window in the home\'s own night', async () => {
    // India is UTC+5:30, so three in the morning there is half past nine here.
    timezone = 'Asia/Kolkata';
    const hub = await updater();
    expect((await hub.setEnabled(true)).window).toEqual({
      from: '2026-10-21T21:30:00.000Z',
      to: '2026-10-21T23:30:00.000Z',
    });
  });

  it('survive a restart, switched on or off', async () => {
    const first = await updater();
    await first.setEnabled(true);
    const second = await updater();
    expect(second.enabled).toBe(true);
    await second.setEnabled(false);
    const third = await updater();
    expect(third.enabled).toBe(false);
    expect(await settings.get('update_rhythm'), 'switching off forgets what was learned').toBeNull();
  });

  it('do nothing outside the window', async () => {
    const hub = await updater();
    await hub.setEnabled(true);
    await hub.tick();
    expect(fetches).toBe(0);
    expect(requested()).toBeUndefined();
  });
});

describe('a night with an update waiting', () => {
  async function switchedOn(options: Parameters<typeof updater>[0] = {}): Promise<AutoUpdater> {
    const hub = await updater(options);
    await hub.setEnabled(true);
    return hub;
  }

  it('asks for the update once nothing is happening', async () => {
    const hub = await switchedOn();
    now = tenPastThree();
    await hub.tick();
    expect(fetches).toBe(1);
    const id = requested();
    expect(id).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
    expect(hub.automaticRunId()).toBe(id);
    expect(hub.describe().last).toEqual({ at: new Date(now).toISOString(), outcome: 'started' });

    const [row] = await rows();
    expect(row?.kind).toBe('hub.update');
    expect(row?.memberId, 'nobody pressed anything').toBeNull();
    expect(row?.message).toBe('The hub started updating itself overnight.');
    expect(row?.data).toMatchObject({ outcome: 'auto-started', automatic: true, fromBuild: BUILD, toSha: 'bbbbbbb' });
  });

  it('writes everything down before it asks, because asking restarts it', async () => {
    let requestExistedWhenWritten: boolean | undefined;
    const hub = await switchedOn({
      recordRow: (row) => {
        if (row.data?.['outcome'] === 'auto-started') requestExistedWhenWritten = existsSync(requestFile());
      },
    });
    now = tenPastThree();
    await hub.tick();
    expect(requestExistedWhenWritten).toBe(false);
    // And the bookkeeping is on disk, not only in this process.
    expect(await settings.get('update_automatic_state')).toMatchObject({
      request: { id: requested(), sha: 'bbbbbbb' },
      attempts: { sha: 'bbbbbbb', count: 1 },
    });
  });

  it('asks once a night, however many times it looks', async () => {
    const hub = await switchedOn();
    now = tenPastThree();
    await hub.tick();
    const first = requested();
    rmSync(requestFile());
    now += 10 * MINUTE;
    await hub.tick();
    expect(requested()).toBeUndefined();
    expect(fetches).toBe(1);
    expect(hub.automaticRunId()).toBe(first);
  });

  it('waits while somebody is about, and goes once they have been quiet for half an hour', async () => {
    const hub = await switchedOn();
    now = tenPastThree() - 20 * MINUTE;
    asked();
    now = tenPastThree();
    await hub.tick();
    expect(requested()).toBeUndefined();
    expect(fetches, 'GitHub is not asked at an hour the hub would not install').toBe(0);
    expect(hub.describe().last).toMatchObject({ outcome: 'postponed', reason: 'in_use' });

    now += 15 * MINUTE;
    await hub.tick();
    expect(requested()).toBeDefined();
  });

  it('waits for a device setting a rule off, but not for one the clock set off', async () => {
    const hub = await switchedOn();
    now = tenPastThree() - 5 * MINUTE;
    ran('interval');
    now = tenPastThree();
    await hub.tick();
    expect(requested(), 'a rule that runs every ten minutes all night must not hold the hub for ever').toBeDefined();
  });

  it.each<[string, () => void]>([
    ['pairing', () => void (busy = true)],
    ['rule_running', () => void (rules.inFlight = true)],
    ['rule_due', () => void (rules.due = true)],
  ])('waits: %s', async (reason, arrange) => {
    const hub = await switchedOn();
    arrange();
    now = tenPastThree();
    await hub.tick();
    expect(requested()).toBeUndefined();
    expect(hub.describe().last).toMatchObject({ outcome: 'postponed', reason });
  });

  it('waits for an update somebody else started', async () => {
    const hub = await switchedOn();
    writeFileSync(
      path.join(dataDir, 'update', 'status.json'),
      JSON.stringify({
        id: 'someone-else',
        state: 'running',
        step: 'download',
        startedAt: new Date(tenPastThree()).toISOString(),
        heartbeat: new Date(tenPastThree()).toISOString(),
        fromBuild: BUILD,
        hubAnswering: true,
        warnings: [],
      }),
    );
    now = tenPastThree();
    await hub.tick();
    expect(requested()).toBeUndefined();
    expect(hub.describe().last).toMatchObject({ outcome: 'postponed', reason: 'update_running' });
  });

  it('does nothing on a hub already on main\'s newest build', async () => {
    head = { sha: 'aaaaaaa', committedAt: NOON - 2 * DAY };
    const hub = await switchedOn();
    now = tenPastThree();
    await hub.tick();
    expect(requested()).toBeUndefined();
    expect(hub.describe().last).toMatchObject({ outcome: 'up_to_date' });
  });

  it('asks GitHub again half an hour after it did not answer, not at every look', async () => {
    head = { error: 'offline' };
    const hub = await switchedOn();
    now = tenPastThree();
    await hub.tick();
    expect(hub.describe().last).toMatchObject({ outcome: 'postponed', reason: 'offline' });
    now += 5 * MINUTE;
    await hub.tick();
    expect(fetches).toBe(1);
    now += 25 * MINUTE;
    await hub.tick();
    expect(fetches).toBe(2);
  });

  it('waits for a build to have been on main for a day', async () => {
    const hub = await switchedOn();
    now = tenPastThree();
    head = { sha: 'bbbbbbb', committedAt: now - 2 * HOUR };
    await hub.tick();
    expect(requested()).toBeUndefined();
    expect(hub.describe().last).toEqual({
      at: new Date(now).toISOString(),
      outcome: 'waiting',
      until: new Date(now - 2 * HOUR + SOAK_MS).toISOString(),
    });
  });

  it('stops waiting for a main that never sits still after a week, and still gives CI two hours', async () => {
    const hub = await switchedOn();
    // A new merge every afternoon: at three in the morning the head is always
    // half a day old, and never a whole one.
    for (let night = 1; night <= 7; night++) {
      now = tenPastThree(night);
      head = { sha: `c${night}c${night}c${night}c`, committedAt: now - 12 * HOUR };
      await hub.tick();
      expect(requested(), `night ${night}`).toBeUndefined();
    }
    // A week behind. A build an hour old is still too new for its bundle…
    now = tenPastThree(8);
    head = { sha: 'd8d8d8d', committedAt: now - HOUR };
    await hub.tick();
    expect(hub.describe().last).toMatchObject({
      outcome: 'waiting',
      until: new Date(now - HOUR + CI_MARGIN_MS).toISOString(),
    });
    // …and the next night one twelve hours old goes in.
    now = tenPastThree(9);
    head = { sha: 'e9e9e9e', committedAt: now - 12 * HOUR };
    await hub.tick();
    expect(requested()).toBeDefined();
  });

  it('never tries a build again by itself that put itself back', async () => {
    const hub = await switchedOn();
    now = tenPastThree();
    await hub.tick();
    runnerFinishes('rolled-back');

    // The hub restarted in between, as it does after any update.
    await hub.stop();
    const restarted = await updater();
    now = tenPastThree(2);
    await restarted.tick();
    expect(requested()).toBeUndefined();
    expect(restarted.describe().last).toMatchObject({ outcome: 'skipped', reason: 'rolled_back' });

    // A different build is a different question.
    head = { sha: 'ccccccc', committedAt: now - 2 * DAY };
    now = tenPastThree(3);
    await restarted.tick();
    expect(requested()).toBeDefined();
  });

  it(`tries one build at most ${MAX_ATTEMPTS} times`, async () => {
    const hub = await switchedOn();
    for (let night = 1; night <= MAX_ATTEMPTS; night++) {
      now = tenPastThree(night);
      await hub.tick();
      expect(requested(), `night ${night}`).toBeDefined();
      runnerFinishes('failed');
    }
    now = tenPastThree(MAX_ATTEMPTS + 1);
    await hub.tick();
    expect(requested()).toBeUndefined();
    expect(hub.describe().last).toMatchObject({ outcome: 'skipped', reason: 'too_many_attempts' });
  });

  it('never updates a branch build, a build from source, or a machine without the runner', async () => {
    const branch = await switchedOn({ build: '0.1.0-aaaaaaa-claude/new-thing' });
    expect(branch.describe()).toMatchObject({ enabled: true, blocked: 'branch_build' });
    expect(branch.describe()).not.toHaveProperty('window');
    now = tenPastThree();
    await branch.tick();
    expect(fetches).toBe(0);
    await branch.stop();

    const fromSource = await updater({ build: undefined });
    expect(fromSource.describe()).toMatchObject({ enabled: true, blocked: 'no_build_stamp' });
    await fromSource.tick();
    expect(fetches).toBe(0);
    await fromSource.stop();

    rmSync(path.join(dataDir, 'update', 'enabled'));
    const bare = await updater();
    expect(bare.describe()).toMatchObject({ enabled: true, blocked: 'unsupported' });
    await bare.tick();
    expect(fetches).toBe(0);
    expect(requested()).toBeUndefined();
  });

  it('says nothing about last night once it is switched off', async () => {
    const hub = await switchedOn();
    now = tenPastThree();
    await hub.tick();
    expect(await hub.setEnabled(false)).toEqual({ enabled: false });
  });
});
