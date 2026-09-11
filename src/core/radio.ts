import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Which radio this hub runs, on a board that was measured for one.
 *
 * A full 512 MB board fits the OS, the hub, and *one* of Zigbee2MQTT (~150 MB,
 * its own process) or Matter (~60-90 MB inside the hub) — not both.
 * `install.sh` measures that and writes the budget into `GETHOME_RADIO`; this
 * file is the other half, the owner's choice between them.
 *
 * **The hub only writes the choice; it never applies it.** Applying it means
 * editing `/etc/gethome/hub.env`, starting or stopping a systemd unit and
 * restarting the hub itself — all root, none of it something a hub process
 * should be able to do. Instead the hub writes one word into its own data
 * directory, a `gethome-radio.path` unit notices, and `gethome-zigbee-detect`
 * applies it. That script already owns this decision: it runs at boot, on
 * every USB plug and unplug, and at the end of the install, and it is the only
 * thing that knows whether a coordinator is actually there.
 *
 * So a mode set here is a *request*. What the hub reports as live comes from
 * `ADAPTER_MATTER` and whether the Zigbee adapter connected — never from this
 * file.
 *
 * **`both` is the one mode that can ask for more than the board was measured
 * for, and it is deliberately allowed to.** The budget is a measurement and
 * the measurement is about a *full* home — the OS, the hub with Matter, and a
 * Zigbee2MQTT holding a hundred devices' state. A home with four devices is
 * nowhere near it, and telling that owner they may not have Matter because of
 * a network they have not built yet is taking something away to prevent a
 * problem they do not have. So the recommendation stays (`budget: 'one'` is
 * what an app warns from) and the refusal is gone — what makes that safe is
 * that the hub *watches*, in `radio-pressure.ts`, and stands a radio down
 * itself if the board really does run out. See `standDownRadio` below.
 */
export type RadioMode = 'auto' | 'zigbee' | 'matter' | 'both';

/**
 * How many radios the board affords at once. Measured, not chosen.
 *
 * Still not a preference and still not settable — what changed is that it is
 * now advice rather than a ceiling: `one` means "this board was measured for
 * one", which is the sentence an app warns with, and not "this board will be
 * given one".
 */
export type RadioBudget = 'both' | 'one';

export const RADIO_MODES: readonly RadioMode[] = ['auto', 'zigbee', 'matter', 'both'] as const;

const FILE = 'radio-mode';
/**
 * When the last switch was asked for.
 *
 * A separate file, and on **disk** rather than in memory, because the whole
 * difficulty of this moment is that the hub is not there for it: applying a
 * radio rewrites `hub.env` and restarts the hub, so the process that recorded
 * the request is killed by the thing it asked for. An app polling `GET /hub`
 * across that gap used to see a connection refused, then a hub reporting the
 * old radios, then the new ones — and drew "can't reach your hub" over a
 * change the person had just made deliberately.
 *
 * One number is enough to turn all of that into one sentence: this hub is
 * switching radios, started at *t*, and here is how long it usually takes.
 */
const REQUESTED_FILE = 'radio-requested';

/**
 * How long a switch may claim to be in progress.
 *
 * A radio change on a Raspberry Pi Zero 2 W is around seventy seconds of a
 * closed port — the hub stops, `hub.env` is rewritten, Zigbee2MQTT is started
 * or stopped and the hub comes back. Twice that is the bound, and it is a
 * bound rather than a wait for the radios to agree because **some requests can
 * never be satisfied**: asking for Zigbee on a hub with no coordinator is a
 * perfectly reasonable thing to do and correctly changes nothing, and a
 * spinner that ran until the radios matched would spin for ever there.
 */
export const RADIO_APPLY_WINDOW_MS = 150_000;

function modeFile(dataDir: string): string {
  return path.join(dataDir, FILE);
}

function requestedFile(dataDir: string): string {
  return path.join(dataDir, REQUESTED_FILE);
}

/**
 * The owner's current choice, or `auto` when they have never made one.
 *
 * `auto` is not a fallback for a damaged file so much as the honest default:
 * follow the hardware. A coordinator is something somebody went out and
 * bought, so it takes the board when it is plugged in; with nothing plugged
 * in, Matter takes it. Anything unreadable or unrecognised reads as `auto`
 * for the same reason — guessing at a corrupted preference is worse than
 * behaving the way an unconfigured hub does.
 */
export function readRadioMode(dataDir: string): RadioMode {
  let raw: string;
  try {
    raw = readFileSync(modeFile(dataDir), 'utf8');
  } catch {
    return 'auto';
  }
  const value = raw.trim();
  return (RADIO_MODES as readonly string[]).includes(value) ? (value as RadioMode) : 'auto';
}

/**
 * Record the owner's choice. Returns once the file is written — the switch
 * itself happens a moment later, out of process, and the hub may be restarted
 * by it, so callers must reply before relying on anything downstream.
 */
export function writeRadioMode(dataDir: string, mode: RadioMode): void {
  mkdirSync(dataDir, { recursive: true });
  // **Before** the mode, because writing the mode is what wakes the path unit
  // that restarts this process: written afterwards, the line would be a line
  // this process may not live long enough to reach.
  try {
    writeFileSync(requestedFile(dataDir), `${Date.now()}\n`, { mode: 0o644 });
  } catch {
    // A hub that cannot record the moment still switches radios; it just
    // cannot say "switching…" while it does. Never worth failing the request.
  }
  // Written in place rather than through a temp file and a rename: the file is
  // one word, so the write is a single syscall, and a plain write is what
  // `PathModified` is guaranteed to notice. The reader validates anyway and
  // falls back to `auto`, so a torn read costs a retry, not a wrong radio.
  writeFileSync(modeFile(dataDir), `${mode}\n`, { mode: 0o644 });
}

/**
 * Whether a radio switch is still being applied, and since when.
 *
 * The answer every caller wants is one boolean, but the *moment* is what makes
 * a progress bar honest rather than a spinner, so both are returned. Absent
 * means no switch is in flight — either none was asked for, or the window has
 * passed and whatever happened has happened.
 */
export function readRadioRequest(dataDir: string): { at: number } | undefined {
  let raw: string;
  try {
    raw = readFileSync(requestedFile(dataDir), 'utf8');
  } catch {
    return undefined;
  }
  const at = Number(raw.trim());
  if (!Number.isFinite(at) || at <= 0) return undefined;
  // A clock that went backwards — a board with no RTC catching up with NTP —
  // must not read as a switch that will be applied in an hour's time.
  if (at > Date.now() + RADIO_APPLY_WINDOW_MS) return undefined;
  if (Date.now() - at > RADIO_APPLY_WINDOW_MS) return undefined;
  return { at };
}

// ── When the board really does run out ──────────────────────────────────────

/**
 * The hub's own record of having stood a radio down.
 *
 * On disk, and for the same reason `radio-requested` is: the hub does this by
 * writing a mode, which **restarts the process that decided to**. A flag in
 * memory would be a flag that died with the decision it describes, and the one
 * moment somebody needs an explanation is the moment after that restart, when
 * half their devices have gone quiet and nobody pressed anything.
 */
const STAND_DOWN_FILE = 'radio-stand-down';

/** Why the hub stopped running both radios by itself. */
export type StandDownReason =
  /** Sustained throttling at the cgroup's `memory.high` — the leading sign. */
  | 'memory-pressure'
  /** Something in the hub's own slice was killed for memory. Unambiguous. */
  | 'out-of-memory';

export interface RadioStandDown {
  /** Epoch ms. */
  at: number;
  reason: StandDownReason;
  /** One sentence naming what was actually measured, for the log and the app. */
  detail?: string;
  /**
   * How many times this hub has had to do it, ever.
   *
   * The count is the whole reason this record outlives the notice it raises.
   * Standing a radio down once on the afternoon somebody paired eight bulbs is
   * a board having a bad minute; doing it a fourth time is the board answering
   * the question, and an app about to offer "run both radios" again should be
   * able to say so rather than presenting a fresh-looking switch.
   */
  count: number;
  /**
   * When somebody set the radio deliberately after it happened.
   *
   * Acknowledgement rather than deletion, because the two halves have
   * different lifetimes: the *notice* is answered the moment the owner makes
   * their own choice, and the *count* is the hub's history with this board and
   * must survive them choosing `both` again. Deleting the record on a mode
   * write would reset the count precisely when it had just become interesting.
   */
  acknowledgedAt?: number;
}

function standDownFile(dataDir: string): string {
  return path.join(dataDir, STAND_DOWN_FILE);
}

/**
 * What this hub has had to do to itself, or nothing if it never has.
 *
 * Unreadable and malformed both read as absent: a damaged record here must
 * never be the reason an app draws a warning nobody can act on, and the count
 * it would have carried is not worth a wrong sentence.
 */
export function readRadioStandDown(dataDir: string): RadioStandDown | undefined {
  let raw: string;
  try {
    raw = readFileSync(standDownFile(dataDir), 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Partial<RadioStandDown>;
  if (typeof record.at !== 'number' || !Number.isFinite(record.at) || record.at <= 0) {
    return undefined;
  }
  if (record.reason !== 'memory-pressure' && record.reason !== 'out-of-memory') return undefined;
  const count =
    typeof record.count === 'number' && Number.isFinite(record.count) && record.count > 0
      ? Math.floor(record.count)
      : 1;
  return {
    at: record.at,
    reason: record.reason,
    ...(typeof record.detail === 'string' && record.detail !== '' ? { detail: record.detail } : {}),
    count,
    ...(typeof record.acknowledgedAt === 'number' && record.acknowledgedAt > 0
      ? { acknowledgedAt: record.acknowledgedAt }
      : {}),
  };
}

/**
 * Record a stand-down, carrying the count forward.
 *
 * Deliberately **not** the thing that changes the radio: the caller writes the
 * record, says so in the activity log and on the socket, and only then writes
 * the mode — because the mode write is what wakes the path unit that kills
 * this process, so anything after it is a line that may never run. Same
 * ordering rule as `writeRadioMode`'s own two writes.
 */
export function writeRadioStandDown(
  dataDir: string,
  entry: { reason: StandDownReason; detail?: string },
): RadioStandDown {
  const previous = readRadioStandDown(dataDir);
  const record: RadioStandDown = {
    at: Date.now(),
    reason: entry.reason,
    ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    count: (previous?.count ?? 0) + 1,
  };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(standDownFile(dataDir), `${JSON.stringify(record)}\n`, { mode: 0o644 });
  return record;
}

/**
 * Mark the notice answered, keeping the history.
 *
 * Called from `PUT /settings/radio`, because somebody choosing a radio — any
 * radio, `both` included — has by definition seen where the hub left them.
 * A no-op when there is nothing recorded, and when it is already answered.
 */
export function acknowledgeRadioStandDown(dataDir: string): void {
  const record = readRadioStandDown(dataDir);
  if (record === undefined || record.acknowledgedAt !== undefined) return;
  try {
    writeFileSync(
      standDownFile(dataDir),
      `${JSON.stringify({ ...record, acknowledgedAt: Date.now() })}\n`,
      { mode: 0o644 },
    );
  } catch {
    // The owner has made a choice either way. A notice that outstays its
    // welcome is worth less than failing the request they actually made.
  }
}
