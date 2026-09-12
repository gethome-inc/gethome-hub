import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRadioPressureWatch,
  Z2M_UNIT,
  type MemorySample,
  type RadioPressureDeps,
} from '../src/core/radio-pressure.js';
import {
  MAX_AUTO_RETRIES,
  RETRY_AFTER_MS,
  readRadioMode,
  readRadioStandDown,
  recordRadioChoice,
  shouldRestoreBoth,
  writeRadioStandDown,
} from '../src/core/radio.js';

/**
 * The watch that makes "run both radios on a 512 MB board" a safe thing to
 * offer.
 *
 * The offer itself is the easy half. The budget in `GETHOME_RADIO` is measured
 * against a **full** home — the OS, the hub with Matter loaded and a
 * Zigbee2MQTT holding a hundred devices' state — so refusing `both` takes
 * Matter away from every four-device home to prevent a problem only a
 * hundred-device home has. Allowing it *unwatched* is the other bad answer:
 * the kernel picks which half of somebody's house stops, at night, with
 * nothing on screen to say why.
 *
 * So the rules under test are all about **not** acting: not on the start-up
 * peak (which is the peak — a cold boot reached 170 MB of a 200 MB ceiling
 * loading `@matter/main`, and a six-second BLE scan afterwards moved
 * `memory.peak` by zero), not on one busy minute, not on a hub that is not
 * running two radios in the first place, and not on a machine whose kernel
 * cannot answer the question at all.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'gethome-pressure-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const log = { info: () => {}, warn: () => {} };

/** A healthy Zero 2 W running both radios, measured: no throttling, ~105 MB free. */
const healthy: MemorySample = {
  high: 0,
  oomKills: 0,
  available: 105 * 1024 * 1024,
  total: 415 * 1024 * 1024,
};

function watcher(
  samples: MemorySample[],
  options: {
    mode?: string;
    budget?: 'both' | 'one';
    zigbee?: boolean;
    matter?: boolean;
    settleMs?: number;
    onStandDown?: RadioPressureDeps['onStandDown'];
    onRestore?: RadioPressureDeps['onRestore'];
    onPressure?: RadioPressureDeps['onPressure'];
    bootId?: string;
    busy?: boolean;
  } = {},
) {
  writeFileSync(path.join(dir, 'radio-mode'), `${options.mode ?? 'both'}\n`);
  let index = 0;
  const read = (): MemorySample => samples[Math.min(index++, samples.length - 1)]!;
  return createRadioPressureWatch({
    dataDir: dir,
    radioBudget: options.budget ?? 'one',
    radiosLive: () => ({ zigbee: options.zigbee ?? true, matter: options.matter ?? true }),
    log,
    onStandDown: options.onStandDown ?? (() => {}),
    ...(options.onRestore !== undefined ? { onRestore: options.onRestore } : {}),
    ...(options.onPressure !== undefined ? { onPressure: options.onPressure } : {}),
    bootId: () => options.bootId,
    busy: () => options.busy === true,
    read,
    // Never fires: every test drives `tick()` itself, because a watch that
    // needs a real clock to be tested is a watch nobody tests the edges of.
    intervalMs: 3_600_000,
    settleMs: options.settleMs ?? 0,
  });
}

/** One reading per call, rising `high` — the board held at its ceiling. */
function throttling(count: number): MemorySample[] {
  return Array.from({ length: count }, (_, index) => ({ ...healthy, high: index }));
}

async function run(watch: { tick(): Promise<void> }, times: number): Promise<void> {
  for (let index = 0; index < times; index += 1) await watch.tick();
}

describe('a hub that has nothing to hand back', () => {
  it('watches what is running, not what was asked for', async () => {
    // **Two live radios is the condition, whatever route the board took to
    // them.** Keying on `mode === 'both'` looked equivalent and is not: a hub
    // whose `GETHOME_RADIO` was edited by hand runs two radios on `auto`, and
    // so does one in the seconds between a stand-down writing the mode and the
    // detector acting on it. Both were unwatched.
    const watch = watcher(throttling(40), { mode: 'auto' });
    await run(watch, 30);
    expect(readRadioStandDown(dir)?.reason).toBe('memory-pressure');
  });

  it('watches nothing while only one radio is actually up', async () => {
    // The mode is a *request*. A hub set to `both` whose coordinator is
    // unplugged is running one radio and has nothing to give back — and
    // standing one down there would take away the only radio it has.
    const watch = watcher(throttling(40), { zigbee: false });
    await run(watch, 30);
    expect(readRadioStandDown(dir)).toBeUndefined();
  });

  it('picks the watch back up when the second radio arrives', async () => {
    // Plugging a stick in is how a hub reaches two radios without anybody
    // restarting it, so applicability is asked every tick rather than decided
    // at start-up.
    let zigbee = false;
    writeFileSync(path.join(dir, 'radio-mode'), 'both\n');
    let index = 0;
    const readings = throttling(40);
    const watch = createRadioPressureWatch({
      dataDir: dir,
      radioBudget: 'one',
      radiosLive: () => ({ zigbee, matter: true }),
      log,
      onStandDown: () => {},
      read: () => readings[Math.min(index++, readings.length - 1)]!,
      intervalMs: 3_600_000,
      settleMs: 0,
    });
    await run(watch, 20);
    expect(readRadioStandDown(dir)).toBeUndefined();
    zigbee = true;
    await run(watch, 20);
    expect(readRadioStandDown(dir)?.reason).toBe('memory-pressure');
  });
});

describe('the start-up peak, which is the peak', () => {
  it('takes no reading at all inside the settle window', async () => {
    const read = vi.fn(() => healthy);
    writeFileSync(path.join(dir, 'radio-mode'), 'both\n');
    const watch = createRadioPressureWatch({
      dataDir: dir,
      radioBudget: 'one',
      radiosLive: () => ({ zigbee: true, matter: true }),
      log,
      onStandDown: () => {},
      read,
      intervalMs: 3_600_000,
      settleMs: 60_000,
    });
    await run(watch, 10);
    // Not merely "did not trip" — the counters are not even read. A hub
    // loading `@matter/main` looks exactly like a hub in trouble, and a
    // baseline taken there is a baseline that makes everything after it look
    // like an improvement.
    expect(read).not.toHaveBeenCalled();
  });
});

describe('a board that really is running out', () => {
  it('hands a radio back after sustained throttling, and not before', async () => {
    const watch = watcher(throttling(40));
    // Ten ticks: one baseline plus nine votes — one short of the window, and
    // so one short of any verdict at all.
    await run(watch, 10);
    expect(readRadioStandDown(dir)).toBeUndefined();
    await run(watch, 2);
    const record = readRadioStandDown(dir);
    expect(record?.reason).toBe('memory-pressure');
    expect(record?.detail).toContain('memory limit');
    expect(record?.count).toBe(1);
    // `auto`, not a named radio: "follow the hardware" is the rule this hub
    // already has for which radio wins, and inventing a second one here would
    // be the policy nobody had read.
    expect(readRadioMode(dir)).toBe('auto');
  });

  it('hands one back at once when something was actually killed', async () => {
    // No window and no patience. By the time `oom_kill` counts, a process has
    // already gone — this is the backstop, not the mechanism.
    const watch = watcher([
      { ...healthy, oomKills: 0 },
      { ...healthy, oomKills: 1 },
    ]);
    await run(watch, 2);
    expect(readRadioStandDown(dir)?.reason).toBe('out-of-memory');
    expect(readRadioMode(dir)).toBe('auto');
  });

  it('hands one back when free memory is gone, with no cgroup at all', async () => {
    // The universal signal. `install.sh` turns the memory controller on, but
    // it needs a reboot to take effect and the rewrite can fail — so a board
    // where `memory.events` does not exist must still be watched.
    const starved: MemorySample = { available: 12 * 1024 * 1024, total: 415 * 1024 * 1024 };
    const watch = watcher([starved]);
    await run(watch, 12);
    const record = readRadioStandDown(dir);
    expect(record?.reason).toBe('memory-pressure');
    expect(record?.detail).toContain('free memory');
  });

  it('says so before it does it', async () => {
    // Ordering, and it is the whole reason this is a callback. Writing the
    // mode wakes the path unit that **restarts this process**, so anything
    // after it is a line that may never run — the activity row nobody reads on
    // Thursday, the socket frame the phone on the sofa never gets.
    let modeAtAnnouncement: string | undefined;
    const watch = watcher(throttling(40), {
      onStandDown: () => {
        modeAtAnnouncement = existsSync(path.join(dir, 'radio-mode'))
          ? readFileSync(path.join(dir, 'radio-mode'), 'utf8').trim()
          : undefined;
      },
    });
    await run(watch, 12);
    expect(modeAtAnnouncement).toBe('both');
    expect(readRadioMode(dir)).toBe('auto');
  });

  it('hands a radio back even while somebody is pairing', async () => {
    // The other half of the asymmetry, and the one that would be tempting to
    // "fix" for consistency. A stand-down is the board being rescued: waiting
    // for a convenient moment risks the kill it exists to prevent, and the
    // pairing was going to be lost either way if the hub is killed for memory.
    const watch = watcher(throttling(40), { busy: true });
    await run(watch, 12);
    expect(readRadioStandDown(dir)?.reason).toBe('memory-pressure');
    expect(readRadioMode(dir)).toBe('auto');
  });

  it('does it once, however many ticks were already in flight', async () => {
    const onStandDown = vi.fn();
    const watch = watcher(throttling(60), { onStandDown });
    await run(watch, 40);
    expect(onStandDown).toHaveBeenCalledTimes(1);
  });
});

describe('a board having a busy afternoon', () => {
  it('rides out a burst that does not fill the window', async () => {
    // Pairing eight bulbs at once is supposed to cost memory. Five bad checks
    // out of ten is a busy afternoon; six is a board that cannot do this.
    const readings: MemorySample[] = [];
    for (let index = 0; index < 30; index += 1) {
      // `high` rises on four ticks in every ten and holds flat on the rest.
      readings.push({ ...healthy, high: Math.floor(index / 10) * 4 + Math.min(index % 10, 4) });
    }
    const watch = watcher(readings);
    await run(watch, 30);
    expect(readRadioStandDown(dir)).toBeUndefined();
    expect(readRadioMode(dir)).toBe('both');
  });

  it('holds steady on a healthy board for as long as you like', async () => {
    const watch = watcher([healthy]);
    await run(watch, 200);
    expect(readRadioStandDown(dir)).toBeUndefined();
  });

  it('never trips on a machine whose kernel says nothing', async () => {
    // macOS, where most of this is written, and any Linux whose memory
    // controller is off. Every field absent means every field abstains — a
    // watch that guessed here would stand a radio down on a developer's laptop.
    const watch = watcher([{}]);
    await run(watch, 200);
    expect(readRadioStandDown(dir)).toBeUndefined();
    expect(readRadioMode(dir)).toBe('both');
  });
});

describe('the record this leaves behind', () => {
  it('counts how often this board has had to do it', async () => {
    writeRadioStandDown(dir, { reason: 'memory-pressure', detail: 'the first time' });
    const watch = watcher(throttling(40));
    await run(watch, 12);
    // The count is why the record outlives the notice it raises. One
    // stand-down on the afternoon somebody paired eight bulbs is a board
    // having a bad minute; a fourth is the board answering the question, and
    // an app about to offer `both` again should be able to say so.
    expect(readRadioStandDown(dir)?.count).toBe(2);
  });

  it('keeps the count when somebody answers the notice', () => {
    writeRadioStandDown(dir, { reason: 'memory-pressure' });
    writeRadioStandDown(dir, { reason: 'out-of-memory' });
    recordRadioChoice(dir, 'matter');
    const record = readRadioStandDown(dir);
    expect(record?.count).toBe(2);
    expect(record?.acknowledgedAt).toBeGreaterThan(0);
  });

  it('does not re-answer a notice that was already answered', () => {
    writeRadioStandDown(dir, { reason: 'memory-pressure' });
    recordRadioChoice(dir, 'matter');
    const first = readRadioStandDown(dir)?.acknowledgedAt;
    recordRadioChoice(dir, 'matter');
    expect(readRadioStandDown(dir)?.acknowledgedAt).toBe(first);
  });

  it('reads a damaged record as no record rather than as a warning', () => {
    // A warning nobody can act on is worse than silence, and the count it
    // would have carried is not worth a wrong sentence.
    for (const content of ['', 'not json', '{}', '{"at":0,"reason":"memory-pressure"}', '{"at":1,"reason":"weather"}']) {
      writeFileSync(path.join(dir, 'radio-stand-down'), content);
      expect(readRadioStandDown(dir)).toBeUndefined();
    }
  });

  it('answers nothing at all on a hub this has never happened to', () => {
    expect(readRadioStandDown(dir)).toBeUndefined();
    recordRadioChoice(dir, 'matter');
    expect(readRadioStandDown(dir)).toBeUndefined();
  });
});

/**
 * The one thing in here that cannot be tested by injecting a reader, and the
 * one that got it wrong first time.
 *
 * `readSystemMemory` reaches absolute paths — `/proc/self/cgroup`,
 * `/sys/fs/cgroup` — so the parts that matter on a Pi are unreachable from a
 * suite that runs on a Mac. The half that is still checkable is the **name**,
 * and it is the half that broke: the unit is `gethome-zigbee2mqtt`, not
 * `zigbee2mqtt`, because the hub installs its own rather than adopting a
 * distribution's. Reading the shorter one opens a path that does not exist,
 * which from here is indistinguishable from "this unit has never been killed"
 * — a missing signal failing in the one direction it must not.
 *
 * So this asserts against the installer itself, the way
 * `test/deploy-radio.test.ts` runs the real detector rather than a copy of it.
 */
describe('the unit Zigbee2MQTT is actually installed as', () => {
  it('is the name this watch reads its counters from', () => {
    const installer = readFileSync(
      path.join(import.meta.dirname, '..', 'deploy', 'install.sh'),
      'utf8',
    );
    // The line that writes the unit file is the definition; anything else in
    // the script referring to it is downstream of this.
    expect(installer).toContain(`/etc/systemd/system/${Z2M_UNIT}`);
  });
});

/**
 * Getting the radio back, which is the half that decides whether any of this
 * was worth doing.
 *
 * **A retry is a trial, not a measurement**, and everything here follows from
 * that one fact. Once a radio has been handed back, the board is no longer
 * running the configuration that failed — the pressure is gone *because* the
 * second radio is gone — so no reading the hub can take says whether both
 * would fit now. There is no such number, and a watch that invented one would
 * have it answer yes for ever.
 *
 * So the hub asks about the **machine** instead: has it restarted, has a week
 * passed. Neither proves anything; both are the things that actually change a
 * board's answer, and the cost of being wrong is bounded to two tries.
 */
describe('putting both radios back', () => {
  /** Stand a hub down, then leave it running one radio. */
  function stoodDown(extra: Partial<Parameters<typeof writeRadioStandDown>[1]> = {}) {
    writeRadioStandDown(dir, {
      reason: 'memory-pressure',
      detail: 'the hub was held at its memory limit in 7 of the last 10 checks',
      wish: 'both',
      bootId: 'boot-a',
      ...extra,
    });
    writeFileSync(path.join(dir, 'radio-mode'), 'auto\n');
  }

  it('tries again once the machine has restarted', async () => {
    stoodDown();
    const onRestore = vi.fn();
    const watch = watcher([healthy], { mode: 'auto', zigbee: false, bootId: 'boot-b', onRestore });
    await run(watch, 3);
    expect(readRadioMode(dir)).toBe('both');
    expect(onRestore).toHaveBeenCalledTimes(1);
    // Counted **before** the mode is written, because the mode write is what
    // restarts this process — a counter reached afterwards is a hub that
    // retries for ever.
    expect(readRadioStandDown(dir)?.autoRetries).toBe(1);
  });

  it('waits on a machine that has not restarted', async () => {
    // The hub restarts itself several times in the course of one stand-down
    // and none of those is evidence of anything, which is exactly why this
    // reads the *machine's* boot rather than counting its own starts.
    stoodDown();
    const watch = watcher([healthy], { mode: 'auto', zigbee: false, bootId: 'boot-a' });
    await run(watch, 20);
    expect(readRadioMode(dir)).toBe('auto');
    expect(readRadioStandDown(dir)?.autoRetries).toBe(0);
  });

  it('tries again after a week on a hub that never restarts', async () => {
    // The weak evidence, and the only thing that reaches a Pi which has been
    // up for months. It costs one restart, which is why it is a week.
    stoodDown({ bootId: 'boot-a' });
    const record = readRadioStandDown(dir)!;
    writeFileSync(
      path.join(dir, 'radio-stand-down'),
      `${JSON.stringify({ ...record, at: Date.now() - RETRY_AFTER_MS - 1000 })}\n`,
    );
    const watch = watcher([healthy], { mode: 'auto', zigbee: false, bootId: 'boot-a' });
    await run(watch, 3);
    expect(readRadioMode(dir)).toBe('both');
  });

  it('stops trying once the tries are spent', async () => {
    stoodDown();
    const record = readRadioStandDown(dir)!;
    writeFileSync(
      path.join(dir, 'radio-stand-down'),
      `${JSON.stringify({ ...record, autoRetries: MAX_AUTO_RETRIES })}\n`,
    );
    const watch = watcher([healthy], { mode: 'auto', zigbee: false, bootId: 'boot-b' });
    await run(watch, 20);
    expect(readRadioMode(dir)).toBe('auto');
  });

  it('holds nothing for somebody who asked for one radio', async () => {
    // The wish is what the hub owes them, and choosing a radio replaces it.
    // Without this the hub would put `both` back over a decision somebody had
    // made *after* the stand-down, which is the same silent overruling the
    // wish exists to prevent, pointed the other way.
    stoodDown();
    recordRadioChoice(dir, 'matter');
    const watch = watcher([healthy], { mode: 'matter', zigbee: false, bootId: 'boot-b' });
    await run(watch, 20);
    expect(readRadioMode(dir)).toBe('matter');
  });

  it('hands the tries back when somebody asks for both themselves', () => {
    // A person deciding is not the hub flapping. Whatever they know that the
    // hub does not — devices removed, a desktop switched off, a bigger board —
    // the two automatic tries are theirs again.
    stoodDown();
    const record = readRadioStandDown(dir)!;
    writeFileSync(
      path.join(dir, 'radio-stand-down'),
      `${JSON.stringify({ ...record, autoRetries: MAX_AUTO_RETRIES })}\n`,
    );
    recordRadioChoice(dir, 'both');
    expect(readRadioStandDown(dir)?.autoRetries).toBe(0);
    // And the lifetime count is untouched by any of it — that is this board's
    // history, and it is what an app says when it offers the switch again.
    expect(readRadioStandDown(dir)?.count).toBe(1);
  });

  it('waits while somebody is standing in front of a device', async () => {
    // **Only the retry waits, and never the stand-down.** A retry is
    // opportunistic and can always happen in an hour; a hub that restarted
    // itself in the middle of a pairing would take the pairing with it, for a
    // trial that had no reason to happen in that particular minute.
    stoodDown();
    const onRestore = vi.fn();
    const watch = watcher([healthy], {
      mode: 'auto',
      zigbee: false,
      bootId: 'boot-b',
      busy: true,
      onRestore,
    });
    await run(watch, 20);
    expect(onRestore).not.toHaveBeenCalled();
    expect(readRadioMode(dir)).toBe('auto');
  });

  it('does nothing at all on a hub this has never happened to', async () => {
    const watch = watcher([healthy], { mode: 'auto', zigbee: false, bootId: 'boot-b' });
    await run(watch, 20);
    expect(readRadioMode(dir)).toBe('auto');
    expect(readRadioStandDown(dir)).toBeUndefined();
  });

  it('will not retry into a hub that is already asking for both', async () => {
    // **The loop guard.** A retry writes `both`, which restarts the hub, which
    // runs this check again — and the record it finds still says a radio is
    // owed, because nothing clears it until the stand-down is superseded. What
    // stops the second write is the mode, so this drives the real tick rather
    // than asserting on the predicate: `shouldRestoreBoth` is deliberately
    // *true* here, and is deliberately not the whole gate.
    stoodDown();
    writeFileSync(path.join(dir, 'radio-mode'), 'both\n');
    expect(shouldRestoreBoth(readRadioStandDown(dir), { bootId: 'boot-b' })).toBe(true);

    const onRestore = vi.fn();
    // One radio live — the hub asked for both and the coordinator has not come
    // back yet, which is exactly the state a retry lands in.
    const watch = watcher([healthy], { mode: 'both', zigbee: false, bootId: 'boot-b', onRestore });
    await run(watch, 20);
    expect(onRestore).not.toHaveBeenCalled();
    expect(readRadioStandDown(dir)?.autoRetries).toBe(0);
  });

  it('starts the tries over when a stand-down is a fresh situation', () => {
    // Two bad afternoons a year apart are not flapping, and a hub that had run
    // both radios happily for months should not be out of tries because of
    // something that happened last spring.
    writeRadioStandDown(dir, { reason: 'memory-pressure', wish: 'both', bootId: 'boot-a' });
    const first = readRadioStandDown(dir)!;
    writeFileSync(
      path.join(dir, 'radio-stand-down'),
      `${JSON.stringify({ ...first, autoRetries: 2, at: Date.now() - RETRY_AFTER_MS - 1000 })}\n`,
    );
    writeRadioStandDown(dir, { reason: 'memory-pressure', wish: 'both', bootId: 'boot-a' });
    expect(readRadioStandDown(dir)).toMatchObject({ autoRetries: 0, count: 2 });
  });
});

describe('whether the machine has changed', () => {
  const record = (extra: object = {}) => ({
    at: Date.now(),
    reason: 'memory-pressure' as const,
    count: 1,
    autoRetries: 0,
    wish: 'both' as const,
    bootId: 'boot-a',
    ...extra,
  });

  it('is nothing to decide with no record', () => {
    expect(shouldRestoreBoth(undefined, { bootId: 'boot-b' })).toBe(false);
  });

  it('needs a wish to restore', () => {
    expect(shouldRestoreBoth(record({ wish: 'matter' }), { bootId: 'boot-b' })).toBe(false);
    expect(shouldRestoreBoth(record({ wish: undefined }), { bootId: 'boot-b' })).toBe(false);
  });

  it('reads an unknown boot as no evidence, not as a reboot', () => {
    // Off Linux, and on any kernel that does not publish one. "We cannot tell"
    // must not read as "it has restarted", or every non-Linux hub retries on
    // its first tick for ever.
    expect(shouldRestoreBoth(record(), { bootId: undefined })).toBe(false);
    expect(shouldRestoreBoth(record({ bootId: undefined }), { bootId: 'boot-b' })).toBe(false);
  });

  it('does not read a clock that went backwards as a week', () => {
    // A board with no real-time clock catching up with NTP writes a record
    // dated in the future. `now - at` is then negative, and the only thing
    // that must not happen is it reading as time having passed.
    const future = record({ at: Date.now() + RETRY_AFTER_MS * 2 });
    expect(shouldRestoreBoth(future, { bootId: 'boot-a' })).toBe(false);
    // The reboot test still works, because it has nothing to do with time.
    expect(shouldRestoreBoth(future, { bootId: 'boot-b' })).toBe(true);
  });
});

/**
 * A board that was measured for both radios.
 *
 * It should never need any of this, which is exactly why it is worth checking:
 * the insurance on a board measured for both is that the hub **says**
 * something and does nothing. There is no second radio to hand back — the
 * board is supposed to run them — so acting would be the hub making a working
 * home smaller to fix a problem that is somewhere else entirely.
 */
describe('a board measured for both', () => {
  it('says the board is short of memory and takes nothing away', async () => {
    const seen: Array<{ detail: string; willStandDown: boolean } | undefined> = [];
    const watch = watcher(throttling(40), {
      budget: 'both',
      onPressure: (next) => seen.push(next),
    });
    await run(watch, 30);
    expect(readRadioStandDown(dir)).toBeUndefined();
    expect(readRadioMode(dir)).toBe('both');
    expect(watch.pressure()?.detail).toContain('memory limit');
    // The field that separates "something is about to happen" from "somebody
    // should look at this". Getting it wrong on a Pi 5 means an app promising
    // a stand-down that is never coming.
    expect(watch.pressure()?.willStandDown).toBe(false);
    expect(seen.filter(Boolean)).toHaveLength(1);
  });

  it('does not act on an out-of-memory kill either, but never hides one', async () => {
    const watch = watcher(
      [
        { ...healthy, oomKills: 0 },
        { ...healthy, oomKills: 1 },
      ],
      { budget: 'both' },
    );
    await run(watch, 2);
    expect(readRadioStandDown(dir)).toBeUndefined();
    expect(watch.pressure()?.detail).toContain('kill');
    expect(watch.pressure()?.willStandDown).toBe(false);
  });
});

describe('what the hub says while it is still deciding', () => {
  it('warns before it acts, which is the only warning a small board gets', async () => {
    // Three checks out of ten is worth telling somebody about; six is a board
    // that cannot go on. The gap between them is a minute and a half in which
    // the owner can make the choice themselves rather than have it made.
    const readings: MemorySample[] = [];
    for (let index = 0; index < 30; index += 1) {
      readings.push({ ...healthy, high: Math.floor(index / 10) * 4 + Math.min(index % 10, 4) });
    }
    const watch = watcher(readings);
    await run(watch, 30);
    expect(readRadioStandDown(dir)).toBeUndefined();
    expect(watch.pressure()).toBeDefined();
    expect(watch.pressure()?.willStandDown).toBe(false);
  });

  it('says nothing at all about a board that is fine', async () => {
    const watch = watcher([healthy]);
    await run(watch, 40);
    expect(watch.pressure()).toBeUndefined();
  });

  it('stops saying it once the board recovers', async () => {
    // Live state, not a record: pressure is something that is happening rather
    // than something that happened, and an app that was warning has to be able
    // to stop. Four bad checks, then a long calm — the window rolls the bad
    // ones out and the warning goes with them.
    const readings: MemorySample[] = [];
    for (let index = 0; index < 5; index += 1) readings.push({ ...healthy, high: index });
    for (let index = 0; index < 40; index += 1) readings.push({ ...healthy, high: 4 });
    const watch = watcher(readings);
    await run(watch, 12);
    expect(watch.pressure()).toBeDefined();
    await run(watch, 12);
    expect(watch.pressure()).toBeUndefined();
  });
});
