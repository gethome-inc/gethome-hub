import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  readBootId,
  readRadioMode,
  readRadioStandDown,
  recordBothRetry,
  shouldRestoreBoth,
  writeRadioMode,
  writeRadioStandDown,
  type RadioStandDown,
  type StandDownReason,
} from './radio.js';

/**
 * The thing that makes "run both radios on a small board" a safe offer.
 *
 * The budget in `GETHOME_RADIO` is a measurement of a *full* home — the OS,
 * the hub with Matter loaded, and a Zigbee2MQTT holding a hundred devices'
 * state — and most homes are nowhere near it. Measured on the Zero 2 W this
 * was developed against, with both radios up, Bluetooth on and one Matter
 * device paired: the hub peaked at 170 MB against a 200 MB `MemoryHigh`,
 * Zigbee2MQTT sat at 30-44 MB, and `memory.events` reported `high 0` and
 * `oom_kill 0` for an hour. That board had about 30 MB of headroom — real, and
 * far too little to promise.
 *
 * So the offer is made and *watched*. Refusing it outright would take Matter
 * away from every owner of a four-device home to prevent a problem only a
 * hundred-device home has; allowing it unwatched would end in the kernel
 * picking which half of somebody's house to switch off, at night, with nothing
 * on screen to say why. This module is the third answer: let them run both,
 * notice the board getting into trouble **before** anything dies, and hand the
 * board back to one radio with an explanation attached.
 *
 * **It watches for throttling, not for deaths.** `install.sh` sets
 * `MemoryHigh` on the hub and on Zigbee2MQTT, and `memory.high` is a
 * *throttle*: the kernel holds the cgroup at the limit and lets the garbage
 * collector catch up, for a long time, before anything is killed. That is the
 * signal worth acting on, because acting on it means nothing is lost. An
 * `oom_kill` is here too, but as a backstop rather than the mechanism — by the
 * time one is counted, a process has already gone.
 *
 * **Nothing here is a judgement about one bad minute.** Pairing eight bulbs at
 * once is supposed to cost memory. A trip needs the board to be in trouble
 * across most of a five-minute window, which is the difference between a busy
 * afternoon and a board that cannot do this.
 */

/** How often the counters are read. Two file reads; nothing measurable. */
const SAMPLE_MS = 30_000;

/**
 * How long after start-up sampling begins.
 *
 * **The peak is the start, not the work**, which is the single most useful
 * thing the measurements turned up: a cold restart with Zigbee2MQTT already
 * resident reached 170 MB while loading `@matter/main` and bringing Bluetooth
 * up, and a six-second BLE scan afterwards moved `memory.peak` by zero. So the
 * first two minutes of every hub's life look exactly like the trouble this is
 * watching for, and sampling through them would stand a radio down on every
 * single boot.
 */
const SETTLE_MS = 120_000;

/**
 * How many samples are kept, how many must be bad before the hub *says* so,
 * and how many before it *acts*.
 *
 * Two thresholds rather than one, because they answer to different people. A
 * board in trouble three checks out of ten is worth telling somebody about on
 * **any** hardware — a Pi 5 included, where handing a radio back would be the
 * wrong move and the right one is a person looking at what is eating the
 * memory. Six of ten is a board that cannot go on, and only there does the hub
 * take something away.
 *
 * The gap between them is also the one warning a small board gets *before*
 * anything happens to it: a minute and a half in which somebody watching their
 * phone can make the choice themselves rather than having it made.
 */
const WINDOW = 10;
const WARN_AT = 3;
const TRIP_AT = 6;

/**
 * When free memory counts as gone: a small share of the board, with a floor.
 *
 * The share is what makes this mean the same thing on a 512 MB board and a
 * 8 GB one; the floor is what stops the share being meaningless on a large
 * one. A healthy Zero 2 W running both radios reported 100-110 MB available of
 * 415 MB — about a quarter — so 8% is a board in real trouble rather than a
 * board that is merely full.
 */
const STARVED_FRACTION = 0.08;
const STARVED_FLOOR_BYTES = 40 * 1024 * 1024;

/**
 * What one read of the kernel's counters gave us.
 *
 * Every field is optional and a missing one simply does not vote: the cgroup
 * memory controller can be off (Raspberry Pi OS ships it off — `install.sh`
 * turns it on, and an install that could not write `cmdline.txt` leaves it
 * off), `/proc/meminfo` does not exist on macOS where most of this is written,
 * and neither absence is a reason to guess.
 */
export interface MemorySample {
  /** The cgroup's `memory.events` `high` counter: times it was throttled. */
  high?: number;
  /** `oom_kill`, summed over the slices this hub can see. */
  oomKills?: number;
  /** `MemAvailable`, in bytes. */
  available?: number;
  /** `MemTotal`, in bytes. */
  total?: number;
}

export type ReadMemory = () => MemorySample;

interface Logger {
  info(obj: object, message: string): void;
  warn(obj: object, message: string): void;
}

/** What the hub is saying about its memory right now, if anything. */
export interface MemoryPressure {
  /** Epoch ms the board first looked like this. */
  since: number;
  /** One sentence naming what was measured. */
  detail: string;
  /**
   * Whether the hub is about to do something about it.
   *
   * False on a board measured for both radios, where there is nothing to hand
   * back — the board is supposed to run them, so the answer is a person
   * looking at what is using the memory, and taking a radio away would be the
   * hub making a working home worse.
   */
  willStandDown: boolean;
}

export interface RadioPressureDeps {
  dataDir: string;
  /**
   * How many radios this board was measured for.
   *
   * The one thing that decides whether pressure is *acted* on. On a board
   * measured for one, two live radios are an override and handing one back
   * restores what was measured. On a board measured for both, they are the
   * design — so the same reading gets the same sentence and no action.
   */
  radioBudget: 'both' | 'one';
  /**
   * Which radios are up **right now**, asked every tick rather than captured.
   *
   * The mode says what was wanted; this says what happened, and this is what
   * decides whether there is anything to watch. A hub set to `both` whose
   * coordinator is unplugged is running one radio and has nothing to stand
   * down — and that changes under us at any moment, because plugging a stick
   * in is a thing people do. Deliberately **not** read from the mode: a board
   * can arrive at two live radios by more than one route (`GETHOME_RADIO` set
   * by hand is the other), and every one of them wants watching.
   */
  radiosLive: () => { zigbee: boolean; matter: boolean };
  log: Logger;
  /**
   * Say so, before the radio is written.
   *
   * Ordering is the whole reason this is a callback rather than something this
   * module does itself: writing the mode wakes the path unit that **restarts
   * this process**, so the activity row and the socket frame have to be out
   * the door first. Exactly the rule `writeRadioMode` follows for its own two
   * writes, and `endMembership` for sockets before the log.
   */
  onStandDown: (record: RadioStandDown) => Promise<void> | void;
  /**
   * The hub is putting both radios back by itself. Same ordering rule.
   *
   * Separate from `onStandDown` because it is the opposite news and reads as
   * the opposite news: one is "your home just got smaller and nobody asked
   * for that", and this one is "the thing you asked for is being tried again".
   */
  onRestore?: (record: RadioStandDown) => Promise<void> | void;
  /** Pressure appeared, changed, or passed. Called with `undefined` when it
   * passes, so an app that was warning stops. */
  onPressure?: (pressure: MemoryPressure | undefined) => void;
  read?: ReadMemory;
  /**
   * This boot, as the kernel names it. Injectable for the same reason `read`
   * is: the real one lives at an absolute path that does not exist on the Mac
   * most of this is written on, and a reboot is the main evidence the retry
   * turns on — so untestable here would mean untested everywhere.
   */
  bootId?: () => string | undefined;
  intervalMs?: number;
  settleMs?: number;
}

export interface RadioPressureWatch {
  start(): void;
  stop(): void;
  /** What the board looks like right now, for `GET /hub`. */
  pressure(): MemoryPressure | undefined;
  /** One pass, exposed so a test can drive this without a clock. */
  tick(): Promise<void>;
}

/** cgroup v2 only. v1 has no unified `memory.events`, and no current Pi runs it. */
function ownCgroupPath(): string | undefined {
  let raw: string;
  try {
    raw = readFileSync('/proc/self/cgroup', 'utf8');
  } catch {
    return undefined;
  }
  // `0::/system.slice/gethome-hubd.service` — the unified hierarchy's line.
  const line = raw.split('\n').find((entry) => entry.startsWith('0::'));
  if (line === undefined) return undefined;
  const relative = line.slice(3).trim();
  if (relative === '' || !relative.startsWith('/')) return undefined;
  return path.join('/sys/fs/cgroup', relative);
}

function readCounter(file: string, key: string): number | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  for (const line of raw.split('\n')) {
    const [name, value] = line.trim().split(/\s+/);
    if (name === key) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function readMeminfo(): { available?: number; total?: number } {
  let raw: string;
  try {
    raw = readFileSync('/proc/meminfo', 'utf8');
  } catch {
    return {};
  }
  const field = (name: string): number | undefined => {
    const match = new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(raw);
    if (match?.[1] === undefined) return undefined;
    const kb = Number(match[1]);
    return Number.isFinite(kb) ? kb * 1024 : undefined;
  };
  const available = field('MemAvailable');
  const total = field('MemTotal');
  return {
    ...(available !== undefined ? { available } : {}),
    ...(total !== undefined ? { total } : {}),
  };
}

/**
 * Zigbee2MQTT's unit, which `deploy/install.sh` writes and
 * `deploy/zigbee-detect.sh` starts and stops.
 *
 * A cross-file contract, and one worth stating rather than guessing: the unit
 * is **`gethome-zigbee2mqtt`**, not `zigbee2mqtt`, because the hub installs its
 * own rather than adopting a distribution's. Guessing the shorter name reads a
 * path that does not exist, which is indistinguishable here from "this unit has
 * never been killed" — the one direction a missing signal must not fail in.
 */
export const Z2M_UNIT = 'gethome-zigbee2mqtt.service';

/**
 * The real reader: this process's own cgroup, Zigbee2MQTT's beside it, and
 * `/proc/meminfo`.
 *
 * Zigbee2MQTT is found as a **sibling** rather than by an absolute path,
 * because the hub's own cgroup already names the slice it was put in and
 * hard-coding `/sys/fs/cgroup/system.slice/` would be a second, dumber copy of
 * a fact systemd already told us. Its counters are the more urgent half: Z2M
 * is the one unit with a hard `MemoryMax`, so it is the process that actually
 * gets killed, and the hub is the one that gets slowly throttled.
 */
export const readSystemMemory: ReadMemory = () => {
  const own = ownCgroupPath();
  const meminfo = readMeminfo();
  if (own === undefined) return meminfo;
  const high = readCounter(path.join(own, 'memory.events'), 'high');
  const ownKills = readCounter(path.join(own, 'memory.events'), 'oom_kill');
  const z2mKills = readCounter(
    path.join(path.dirname(own), Z2M_UNIT, 'memory.events'),
    'oom_kill',
  );
  const kills =
    ownKills === undefined && z2mKills === undefined ? undefined : (ownKills ?? 0) + (z2mKills ?? 0);
  return {
    ...meminfo,
    ...(high !== undefined ? { high } : {}),
    ...(kills !== undefined ? { oomKills: kills } : {}),
  };
};

/** One sample's verdict, once it has something to be compared against. */
interface Verdict {
  throttled: boolean;
  starved: boolean;
}

export function createRadioPressureWatch(deps: RadioPressureDeps): RadioPressureWatch {
  const read = deps.read ?? readSystemMemory;
  const intervalMs = deps.intervalMs ?? SAMPLE_MS;
  const settleMs = deps.settleMs ?? SETTLE_MS;
  const bootId = deps.bootId ?? readBootId;
  const startedAt = Date.now();
  /** Two live radios on a board measured for one: the only case with a move. */
  const overCommitted = deps.radioBudget === 'one';

  let timer: NodeJS.Timeout | undefined;
  let previous: MemorySample | undefined;
  let window: Verdict[] = [];
  let pressure: MemoryPressure | undefined;
  /**
   * Set once this process has written a mode, so a tick already in flight
   * cannot write a second one. It covers both directions — standing a radio
   * down and putting one back — because both end the same way: the path unit
   * wakes and this process is restarted out from under whatever runs next.
   */
  let acted = false;

  const forget = (): void => {
    previous = undefined;
    window = [];
    report(undefined);
  };

  /** Say it once, and say when it stops. */
  function report(next: MemoryPressure | undefined): void {
    const was = pressure?.detail;
    if (was === next?.detail) return;
    pressure = next;
    deps.onPressure?.(next);
    if (next !== undefined) {
      deps.log.warn({ detail: next.detail, willStandDown: next.willStandDown }, 'Memory pressure');
    } else if (was !== undefined) {
      deps.log.info({}, 'Memory pressure has passed');
    }
  }

  const standDown = async (reason: StandDownReason, detail: string): Promise<void> => {
    acted = true;
    stop();
    // **The wish, recorded at the moment it is taken away.** Without it the
    // act of protecting the board throws away the decision it was protecting,
    // and the owner's only way back is to notice and press the switch again.
    const currentBoot = bootId();
    const record = writeRadioStandDown(deps.dataDir, {
      reason,
      detail,
      wish: 'both',
      ...(currentBoot !== undefined ? { bootId: currentBoot } : {}),
    });
    deps.log.warn(
      { reason, detail, count: record.count },
      'Standing a radio down: this board cannot hold both',
    );
    try {
      await deps.onStandDown(record);
    } catch {
      // Saying so is worth a lot and is worth nothing compared with actually
      // doing it. A failed announcement must not leave the board over-committed.
    }
    // **Last.** This is what wakes `gethome-radio.path`, which restarts this
    // process — so everything that had to be said is already said.
    //
    // `auto` rather than a named radio, because `auto` is the rule this hub
    // already has for "follow the hardware": a coordinator somebody went out
    // and bought takes the board, and Matter takes it where there is none.
    // Choosing a radio here would be inventing a second policy for the same
    // question, and it would be the policy nobody had read.
    writeRadioMode(deps.dataDir, 'auto');
  };

  /**
   * Put both radios back, because the machine is not the machine that failed.
   *
   * **A trial, not a measurement.** Once a radio has been handed back the
   * board is no longer running the configuration that failed, so nothing it
   * reports can say whether that configuration would fit now — the pressure is
   * gone *because* the second radio is gone. `shouldRestoreBoth` therefore
   * asks about the machine (has it rebooted, has a week passed) rather than
   * about the memory, and the budget for being wrong is two.
   */
  const restore = async (record: RadioStandDown): Promise<void> => {
    acted = true;
    stop();
    // Before the mode, like everything else here: counted afterwards, a
    // counter this process never reaches is a hub that retries for ever.
    recordBothRetry(deps.dataDir);
    deps.log.info(
      { count: record.count, autoRetries: record.autoRetries + 1 },
      'Trying both radios again',
    );
    try {
      await deps.onRestore?.({ ...record, autoRetries: record.autoRetries + 1 });
    } catch {
      // As above: the trial matters more than the announcement of it.
    }
    writeRadioMode(deps.dataDir, 'both');
  };

  const tick = async (): Promise<void> => {
    if (acted) return;
    const live = deps.radiosLive();

    // ── One radio running ────────────────────────────────────────────────
    // Nothing to watch and possibly something to give back. This is the only
    // path that can restore, and it is deliberately behind the same settle
    // window as the sampling: a restart two seconds into a boot races the
    // detector's own boot run for no gain, and the whole point of riding a
    // reboot is that the owner is already expecting the hub to be starting.
    if (!live.zigbee || !live.matter) {
      forget();
      if (Date.now() - startedAt < settleMs) return;
      const record = readRadioStandDown(deps.dataDir);
      if (
        readRadioMode(deps.dataDir) !== 'both' &&
        shouldRestoreBoth(record, { bootId: bootId() })
      ) {
        await restore(record!);
      }
      return;
    }

    // ── Two radios running ───────────────────────────────────────────────
    if (Date.now() - startedAt < settleMs) return;

    const sample = read();
    const before = previous;
    previous = sample;
    // The first sample after the settle window is a baseline and votes on
    // nothing: `high` and `oom_kill` are counters since boot, so a single
    // reading of either says only that this board has been up for a while.
    if (before === undefined) return;

    if (
      sample.oomKills !== undefined &&
      before.oomKills !== undefined &&
      sample.oomKills > before.oomKills
    ) {
      const detail = 'the operating system had to kill something in this hub to free memory';
      report({ since: Date.now(), detail, willStandDown: overCommitted });
      if (overCommitted) await standDown('out-of-memory', detail);
      return;
    }

    const throttled =
      sample.high !== undefined && before.high !== undefined && sample.high > before.high;
    const starved =
      sample.available !== undefined &&
      sample.available <
        Math.max(
          STARVED_FLOOR_BYTES,
          sample.total !== undefined ? sample.total * STARVED_FRACTION : 0,
        );

    window.push({ throttled, starved });
    if (window.length > WINDOW) window = window.slice(-WINDOW);
    if (window.length < WINDOW) return;

    const throttles = window.filter((entry) => entry.throttled).length;
    const starvations = window.filter((entry) => entry.starved).length;
    const worst = Math.max(throttles, starvations);
    if (worst < WARN_AT) {
      report(undefined);
      return;
    }

    const detail =
      throttles >= starvations
        ? `the hub was held at its memory limit in ${throttles} of the last ${WINDOW} checks`
        : `this board had almost no free memory left in ${starvations} of the last ${WINDOW} checks`;
    // Said on every board, acted on only where there is something to hand
    // back. A Pi 5 under real memory pressure is a person's problem to look
    // at; taking a radio off it would be the hub making a working home worse.
    report({
      since: pressure?.since ?? Date.now(),
      detail,
      willStandDown: overCommitted && worst >= TRIP_AT,
    });
    if (overCommitted && worst >= TRIP_AT) {
      await standDown('memory-pressure', detail);
    }
  };

  function stop(): void {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  }

  return {
    start() {
      if (timer !== undefined) return;
      const existing = readRadioStandDown(deps.dataDir);
      if (existing !== undefined) {
        deps.log.info(
          {
            at: existing.at,
            reason: existing.reason,
            count: existing.count,
            wish: existing.wish,
            autoRetries: existing.autoRetries,
          },
          'This hub has stood a radio down before',
        );
      }
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
      // Never a reason to hold the process open: this is a watch on something
      // that only matters while the hub is otherwise busy running.
      timer.unref();
    },
    stop,
    pressure: () => pressure,
    tick,
  };
}
