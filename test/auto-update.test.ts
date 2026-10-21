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
import { watchUpdateOutcomes, type HeadCommit, type UpdateOutcomeWatch } from '../src/core/update.js';
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
  options: {
    build?: string | undefined;
    recordRow?: (row: ActivityInput) => void;
    /** Told about every setting the updater writes, before it is written. */
    onSet?: (key: string, value: unknown) => void;
    fetchHead?: () => Promise<HeadCommit>;
  } = {},
): Promise<AutoUpdater> {
  const made = createAutoUpdater({
    dataDir,
    build: 'build' in options ? options.build : BUILD,
    settings: {
      get: <T>(key: string) => settings.get<T>(key),
      set: async (key, value) => {
        options.onSet?.(key, value);
        await settings.set(key, value);
      },
      unset: (key) => settings.unset(key),
    },
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
    fetchHead:
      options.fetchHead ??
      (async () => {
        fetches += 1;
        return head;
      }),
  });
  await made.load();
  made.start();
  updaters.push(made);
  return made;
}

/** How a hub hears the runner's last word: the watch `src/index.ts` starts at boot. */
function outcomes(hub: AutoUpdater): UpdateOutcomeWatch {
  return watchUpdateOutcomes({
    dataDir,
    activity,
    log: silent,
    ended: (run) => hub.runEnded(run),
    automaticRunId: () => hub.automaticRunId(),
    now: () => now,
  });
}

const requestFile = (): string => path.join(dataDir, 'update', 'request');
const statusFile = (): string => path.join(dataDir, 'update', 'status.json');
const requested = (): string | undefined =>
  existsSync(requestFile()) ? readFileSync(requestFile(), 'utf8').trim() : undefined;

function writeStatus(id: string | undefined, state: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    statusFile(),
    JSON.stringify({
      id,
      state,
      step: state === 'running' ? 'download' : 'done',
      startedAt: new Date(now).toISOString(),
      heartbeat: new Date(now).toISOString(),
      fromBuild: BUILD,
      hubAnswering: state !== 'running',
      warnings: [],
      ...extra,
    }),
  );
}

/** What the root runner does with a request first: consume it, and say it is running. */
function runnerStarts(): void {
  const id = requested();
  rmSync(requestFile(), { force: true });
  writeStatus(id, 'running');
}

/**
 * …and last — which, for every run that restarts the hub, is *after* the hub
 * is back: the installer waits for the new build's health check (or flips back
 * and restarts the old one) before the runner asks what is live and says how
 * it went.
 */
function runnerFinishes(state: 'succeeded' | 'rolled-back' | 'failed', liveBuild = BUILD): void {
  if (requested() !== undefined) runnerStarts();
  const id = (JSON.parse(readFileSync(statusFile(), 'utf8')) as { id: string }).id;
  writeStatus(id, state, { liveBuild, finishedAt: new Date(now).toISOString() });
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

  it('dates a beginning made before the clock was set by the first true reading, and writes nothing before', async () => {
    // A boot that finds automatic updates on with nothing learned begins
    // again — and on a board with no RTC that can be 1970, which read back
    // against the real date is decades "learned" from nothing.
    now = Date.UTC(1970, 0, 1, 0, 0, 10);
    const quiet = quietHours();
    await quiet.load();
    quiet.start();
    await quiet.begin();
    expect(quiet.recording).toBe(true);
    expect(await settings.get('update_rhythm'), 'nothing dated 1970 is written down').toBeNull();

    now = NOON;
    expect(quiet.window('UTC').learned, 'the clock is set, and nothing has been learned yet').toBe(false);
    asked();
    await quiet.flush();
    expect(await settings.get('update_rhythm')).toEqual({ v: 1, since: NOON, hours: [[Math.floor(NOON / HOUR), 1]] });
    await quiet.stop();
  });

  it('begins again a record that was dated against a clock that had not been set', async () => {
    // What the first build of this wrote in that case.
    await settings.set('update_rhythm', { v: 1, since: 10_000, hours: [[Math.floor(NOON / HOUR), 40]] });
    const quiet = quietHours();
    await quiet.load();
    expect(quiet.recording).toBe(true);
    expect(quiet.window('UTC')).toEqual({ startHour: DEFAULT_WINDOW_START, hours: 2, learned: false });
    await quiet.flush();
    expect(await settings.get('update_rhythm')).toEqual({ v: 1, since: NOON, hours: [] });
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

  it('writes its books before it asks, because asking restarts it — and the feed only once it has', async () => {
    let requestExistedWhenBooked: boolean | undefined;
    let requestExistedWhenWritten: boolean | undefined;
    const hub = await switchedOn({
      onSet: (key, value) => {
        if (key === 'update_automatic_state' && (value as { request?: unknown }).request !== undefined) {
          requestExistedWhenBooked ??= existsSync(requestFile());
        }
      },
      recordRow: (row) => {
        if (row.data?.['outcome'] === 'auto-started') requestExistedWhenWritten = existsSync(requestFile());
      },
    });
    now = tenPastThree();
    await hub.tick();
    expect(requestExistedWhenBooked, 'an attempt counted after the request is one a dead runner never counts').toBe(
      false,
    );
    expect(requestExistedWhenWritten, 'a row before the request is a claim the request may not keep').toBe(true);
    // And the bookkeeping is on disk, not only in this process.
    expect(await settings.get('update_automatic_state')).toMatchObject({
      request: { id: requested(), sha: 'bbbbbbb' },
      attempts: { sha: 'bbbbbbb', count: 1 },
    });
  });

  it('says nothing in the feed about an update it could not ask for', async () => {
    const hub = await switchedOn();
    // Something already sits where the request goes, so it cannot be written.
    mkdirSync(requestFile());
    now = tenPastThree();
    await hub.tick();
    expect(await rows()).toHaveLength(0);
    expect(hub.describe().last).toMatchObject({ outcome: 'postponed', reason: 'request_failed' });
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

  it('counts the week behind again from nothing once it has updated', async () => {
    // Without this, a hub that updated on its first night was "a week behind"
    // seven days later, however often it had updated since — and from then on
    // installed every build two hours after it merged.
    const hub = await switchedOn();
    now = tenPastThree(1);
    await hub.tick();
    expect(requested()).toBeDefined();
    runnerFinishes('succeeded', '0.1.0-bbbbbbb-main');

    // Back on the new build, behind a main that gets a merge every afternoon.
    await hub.stop();
    const updated = await updater({ build: '0.1.0-bbbbbbb-main' });
    for (let night = 2; night <= 8; night++) {
      now = tenPastThree(night);
      head = { sha: `c${night}c${night}c${night}c`, committedAt: now - 12 * HOUR };
      await updated.tick();
      expect(requested(), `night ${night}: this build has been behind ${night - 2} days`).toBeUndefined();
    }
    now = tenPastThree(9);
    head = { sha: 'e9e9e9e', committedAt: now - 12 * HOUR };
    await updated.tick();
    expect(requested(), 'a week after this build fell behind').toBeDefined();
  });

  it('asks GitHub once a window when there is nothing to do', async () => {
    head = { sha: 'aaaaaaa', committedAt: NOON - 2 * DAY };
    const hub = await switchedOn();
    for (let minute = 10; minute < 120; minute += 5) {
      now = Date.UTC(2026, 9, 22, 3, minute);
      await hub.tick();
    }
    expect(fetches, 'two hours of looks, one question').toBe(1);
    expect(hub.describe().last).toMatchObject({ outcome: 'up_to_date' });
    now = tenPastThree(2);
    await hub.tick();
    expect(fetches, 'and one the next night').toBe(2);
  });

  it('asks again inside the window when the build it waits for comes of age there', async () => {
    const hub = await switchedOn();
    now = tenPastThree();
    head = { sha: 'bbbbbbb', committedAt: now + 30 * MINUTE - SOAK_MS };
    await hub.tick();
    expect(hub.describe().last).toMatchObject({
      outcome: 'waiting',
      until: new Date(now + 30 * MINUTE).toISOString(),
    });
    now += 25 * MINUTE;
    await hub.tick();
    expect(fetches).toBe(1);
    now += 5 * MINUTE;
    await hub.tick();
    expect(fetches).toBe(2);
    expect(requested()).toBeDefined();
  });

  it('names the moment the week behind runs out, when that comes before the day', async () => {
    const hub = await switchedOn();
    // First seen behind at four one night…
    now = Date.UTC(2026, 9, 22, 4, 0);
    head = { sha: 'c1c1c1c', committedAt: now - 30 * MINUTE };
    await hub.tick();
    // …so a week later the week runs out at four, while a build merged at two
    // would otherwise be waited for until two the next day.
    now = Date.UTC(2026, 9, 29, 3, 10);
    head = { sha: 'c8c8c8c', committedAt: Date.UTC(2026, 9, 29, 2, 0) };
    await hub.tick();
    expect(hub.describe().last).toMatchObject({ outcome: 'waiting', until: '2026-10-29T04:00:00.000Z' });
    now = Date.UTC(2026, 9, 29, 4, 0);
    await hub.tick();
    expect(requested()).toBeDefined();
  });

  it('lets go of an answer that arrives after the switch went off', async () => {
    let answer!: (head: HeadCommit) => void;
    const hub = await switchedOn({
      fetchHead: () =>
        new Promise<HeadCommit>((resolve) => {
          answer = resolve;
        }),
    });
    now = tenPastThree();
    const looking = hub.tick();
    // GitHub takes its time; somebody switches it off meanwhile.
    await hub.setEnabled(false);
    answer(head);
    await looking;
    expect(requested()).toBeUndefined();
    expect(await rows()).toHaveLength(0);
    expect(await settings.get('update_automatic_state')).not.toHaveProperty('request');
  });

  it('works its window out again when the clock is put back', async () => {
    // A board that booted months ahead of the real time, and was put right.
    now = Date.UTC(2027, 2, 1, 12, 0);
    const hub = await switchedOn();
    expect(hub.describe().window?.from).toBe('2027-03-02T03:00:00.000Z');
    now = tenPastThree();
    expect(hub.describe().window?.from).toBe('2026-10-22T03:00:00.000Z');
    await hub.tick();
    expect(requested()).toBeDefined();
  });

  it('never tries a build again by itself that put itself back', async () => {
    const hub = await switchedOn();
    now = tenPastThree();
    await hub.tick();
    runnerStarts();

    // The installer restarts the hub — the new build, which fails its health
    // check, and then the old one — before the runner says how it went. So the
    // boot that follows finds the run still going…
    await hub.stop();
    now += 4 * MINUTE;
    const restarted = await updater();
    const watch = outcomes(restarted);
    expect(await watch.check(), 'the boot after an update never hears how it ended').toBe(true);

    // …and the runner's last word lands with the hub already up.
    now += MINUTE;
    runnerFinishes('rolled-back');
    expect(await watch.check()).toBe(false);
    const [row] = await rows();
    expect(row?.message).toContain("won't try that version by itself again");
    expect(row?.data).toMatchObject({ outcome: 'rolled-back', automatic: true });

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

  it('writes down how a run ended that never restarted the hub, once', async () => {
    // A download that failed, a lock somebody else held: this process stays
    // up, and nothing else would ever say so.
    const hub = await switchedOn();
    const watch = outcomes(hub);
    now = tenPastThree();
    await hub.tick();
    expect(await watch.check(), 'the runner has not picked it up yet').toBe(false);
    runnerStarts();
    expect(await watch.check()).toBe(true);
    runnerFinishes('failed');
    await watch.check();
    await watch.check();
    const ended = (await rows()).filter((row) => (row.data as { outcome?: string } | null)?.outcome === 'failed');
    expect(ended).toHaveLength(1);
    expect(ended[0]?.message).toBe("The hub's automatic update didn't finish.");
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
