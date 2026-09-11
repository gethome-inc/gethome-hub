import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  readRadioMode,
  readRadioStandDown,
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

/** How many samples are kept, and how many of them must be bad to trip. */
const WINDOW = 10;
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

export interface RadioPressureDeps {
  dataDir: string;
  /**
   * Which radios are up **right now**, asked every tick rather than captured.
   *
   * The mode says what was wanted; this says what happened. A hub set to
   * `both` on a board whose coordinator is unplugged is running one radio and
   * has nothing to stand down, so it must not be watched — and that can change
   * under us at any moment, because plugging a stick in is a thing people do.
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
  read?: ReadMemory;
  intervalMs?: number;
  settleMs?: number;
}

export interface RadioPressureWatch {
  start(): void;
  stop(): void;
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
    path.join(path.dirname(own), 'zigbee2mqtt.service', 'memory.events'),
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
  const startedAt = Date.now();

  let timer: NodeJS.Timeout | undefined;
  let previous: MemorySample | undefined;
  let window: Verdict[] = [];
  /** Set once a stand-down has been written, so a tick already in flight during
   * the restart cannot write a second one. */
  let stoodDown = false;

  const forget = (): void => {
    previous = undefined;
    window = [];
  };

  const standDown = async (reason: StandDownReason, detail: string): Promise<void> => {
    stoodDown = true;
    stop();
    const record = writeRadioStandDown(deps.dataDir, { reason, detail });
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

  const tick = async (): Promise<void> => {
    if (stoodDown) return;

    // Only a hub asked to run both, that really is running both, has anything
    // to give back. Read per tick: the mode can be changed from another app
    // and a coordinator can be plugged in while this is running.
    const live = deps.radiosLive();
    if (readRadioMode(deps.dataDir) !== 'both' || !live.zigbee || !live.matter) {
      forget();
      return;
    }
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
      await standDown(
        'out-of-memory',
        'the operating system had to kill something in this hub to free memory',
      );
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
    if (throttles >= TRIP_AT) {
      await standDown(
        'memory-pressure',
        `the hub was held at its memory limit in ${throttles} of the last ${WINDOW} checks`,
      );
      return;
    }
    if (starvations >= TRIP_AT) {
      await standDown(
        'memory-pressure',
        `this board had almost no free memory left in ${starvations} of the last ${WINDOW} checks`,
      );
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
          { at: existing.at, reason: existing.reason, count: existing.count },
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
    tick,
  };
}
