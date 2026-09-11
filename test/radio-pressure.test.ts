import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRadioPressureWatch,
  type MemorySample,
  type RadioPressureDeps,
} from '../src/core/radio-pressure.js';
import {
  acknowledgeRadioStandDown,
  readRadioMode,
  readRadioStandDown,
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
    zigbee?: boolean;
    matter?: boolean;
    settleMs?: number;
    onStandDown?: RadioPressureDeps['onStandDown'];
  } = {},
) {
  writeFileSync(path.join(dir, 'radio-mode'), `${options.mode ?? 'both'}\n`);
  let index = 0;
  const read = (): MemorySample => samples[Math.min(index++, samples.length - 1)]!;
  return createRadioPressureWatch({
    dataDir: dir,
    radiosLive: () => ({ zigbee: options.zigbee ?? true, matter: options.matter ?? true }),
    log,
    onStandDown: options.onStandDown ?? (() => {}),
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
  it('watches nothing on a hub that was never asked for both', async () => {
    const watch = watcher(throttling(40), { mode: 'auto' });
    await run(watch, 30);
    expect(readRadioStandDown(dir)).toBeUndefined();
    expect(readRadioMode(dir)).toBe('auto');
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
    acknowledgeRadioStandDown(dir);
    const record = readRadioStandDown(dir);
    expect(record?.count).toBe(2);
    expect(record?.acknowledgedAt).toBeGreaterThan(0);
  });

  it('does not re-answer a notice that was already answered', () => {
    writeRadioStandDown(dir, { reason: 'memory-pressure' });
    acknowledgeRadioStandDown(dir);
    const first = readRadioStandDown(dir)?.acknowledgedAt;
    acknowledgeRadioStandDown(dir);
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
    acknowledgeRadioStandDown(dir);
    expect(readRadioStandDown(dir)).toBeUndefined();
  });
});
