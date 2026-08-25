import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ActivityService } from './activity.js';
import type { Logger } from '../logging.js';

/**
 * Updating this hub, asked for from an app.
 *
 * **The hub records the request; it never applies it.** Applying means writing
 * `/opt/gethome`, moving the `current` symlink and restarting a systemd unit —
 * all root, none of it something a network-facing process should be able to do.
 * So this writes one line into the hub's own data directory,
 * `gethome-update.path` notices, and `/usr/local/lib/gethome-update.sh` does
 * the work as root. Exactly the trade `core/radio.ts` makes, for exactly the
 * same reason: no sudo rule, nothing new to lock down.
 *
 * Two consequences for callers. `POST /system/update` returns a *receipt* — the
 * work has not started and this process is about to be restarted by it. And
 * everything reported about a run is read back off the runner's status file
 * rather than held in memory, because the hub does not survive its own update.
 */

/** The runner's own vocabulary. `stalled` is added here, not by the runner. */
const RUN_STATES = ['running', 'succeeded', 'rolled-back', 'failed'] as const;
export type UpdateRunState = (typeof RUN_STATES)[number] | 'stalled';

const runFileSchema = z.object({
  id: z.string().min(1),
  state: z.enum(RUN_STATES),
  step: z.string(),
  startedAt: z.string(),
  heartbeat: z.string(),
  fromBuild: z.string(),
  hubAnswering: z.boolean(),
  warnings: z.array(z.string()),
  liveBuild: z.string().optional(),
  finishedAt: z.string().optional(),
  error: z.string().optional(),
});

export type UpdateRunFile = z.infer<typeof runFileSchema>;
export type UpdateRun = Omit<UpdateRunFile, 'state'> & { state: UpdateRunState };

/**
 * How long a `running` run may go without a heartbeat before it is reported as
 * stalled.
 *
 * The runner stamps one on every status write and at least every ten seconds
 * while the installer prints, so this is generous by two orders of magnitude.
 * It exists for the case that has no other exit: the board loses power, or the
 * OOM killer takes the runner, and `status.json` says `running` for ever. Left
 * alone that is a progress bar that never moves *and* a `409` on every attempt
 * to try again — one power cut locking the hub out of ever being updated from
 * an app.
 */
const STALE_AFTER_MS = 20 * 60 * 1000;

function updateDir(dataDir: string): string {
  return path.join(dataDir, 'update');
}

/**
 * Whether this machine has the plumbing at all.
 *
 * `install.sh` touches this in the same breath as it writes the two units, so
 * it cannot promise a runner that was never installed. Deliberately a file in
 * the hub's own directory rather than a check on a path under
 * `/etc/systemd/system`: `src/` stays portable, and a hub that has never been
 * through an installer new enough to write the units answers honestly.
 */
export function canApplyUpdate(dataDir: string): boolean {
  return existsSync(path.join(updateDir(dataDir), 'enabled'));
}

/**
 * Ask for an update. Returns the run id, which the runner copies into its
 * status so an app can tell its own request from one somebody else made.
 *
 * Written in place rather than through a temp file and a rename, for the reason
 * `writeRadioMode` gives: one short line is a single write, which is what
 * `PathModified` is guaranteed to notice, and the runner validates and re-reads
 * once — so a torn read costs a retry, not a wrong action.
 */
export function requestUpdate(dataDir: string): string {
  const id = randomUUID();
  mkdirSync(updateDir(dataDir), { recursive: true });
  writeFileSync(path.join(updateDir(dataDir), 'request'), `${id}\n`, { mode: 0o644 });
  return id;
}

/** The current or last run, or undefined when this hub has never had one. */
export function readUpdateRun(dataDir: string, now = Date.now()): UpdateRun | undefined {
  let raw: string;
  try {
    raw = readFileSync(path.join(updateDir(dataDir), 'status.json'), 'utf8');
  } catch {
    return undefined;
  }
  let parsed: UpdateRunFile;
  try {
    parsed = runFileSchema.parse(JSON.parse(raw));
  } catch {
    // A half-written file is the runner mid-rename, or a version of it this
    // build doesn't understand. Either way "no run" is the honest answer and
    // the next read will get it — never throw from here: `GET /system/update`
    // is the only way an app learns anything about updating at all.
    return undefined;
  }
  if (parsed.state !== 'running') return parsed;
  const beat = Date.parse(parsed.heartbeat);
  if (Number.isNaN(beat) || now - beat <= STALE_AFTER_MS) return parsed;
  return { ...parsed, state: 'stalled' };
}

/**
 * How much of the log is ever held in memory at once. An install prints a few
 * hundred kilobytes at most, but this runs on a board with 512 MB and an SD
 * card, and nothing here is worth reading the whole file for: the tail is what
 * anybody looks at. Read from the end, and the first partial line is dropped
 * rather than shown cut in half.
 */
const LOG_TAIL_BYTES = 128 * 1024;

/** The last N lines the installer printed, and how many were in the tail read. */
export function readUpdateLog(
  dataDir: string,
  tail: number,
): { lines: string[]; total: number; truncated: boolean } {
  const file = path.join(updateDir(dataDir), 'last.log');
  let raw: string;
  let truncated = false;
  let handle: number | undefined;
  try {
    handle = openSync(file, 'r');
    const size = fstatSync(handle).size;
    const from = Math.max(0, size - LOG_TAIL_BYTES);
    const length = size - from;
    const buffer = Buffer.alloc(length);
    readSync(handle, buffer, 0, length, from);
    raw = buffer.toString('utf8');
    if (from > 0) {
      truncated = true;
      // Dropped rather than shown: reading from an arbitrary offset lands in
      // the middle of a line, and on a non-ASCII one in the middle of a
      // character.
      const firstBreak = raw.indexOf('\n');
      raw = firstBreak === -1 ? '' : raw.slice(firstBreak + 1);
    }
  } catch {
    return { lines: [], total: 0, truncated: false };
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
  const all = raw.split('\n');
  if (all.length > 0 && all[all.length - 1] === '') all.pop();
  if (all.length > tail) truncated = true;
  return { lines: all.slice(Math.max(0, all.length - tail)), total: all.length, truncated };
}

// ── Which build is this, and is there a newer one ──────────────────────────

export interface BuildStamp {
  build: string;
  version: string;
  sha: string;
  channel: string;
}

/**
 * Pull the commit out of CI's stamp — `<version>-<short sha>-<branch>`.
 *
 * Only the first two fields are positional, because a branch name can itself
 * contain dashes. A hub built from source on its own machine has no stamp at
 * all, and that is the case this returns `undefined` for: it is the difference
 * between "up to date" and "cannot say", and they must not be collapsed.
 *
 * GetHome Studio parses the same string in `HubUpdater.commit(inBuild:)`; the
 * two have to agree about what a build id is.
 */
export function parseBuild(build: string | undefined): BuildStamp | undefined {
  if (build === undefined || build.length === 0) return undefined;
  const parts = build.split('-');
  if (parts.length < 3) return undefined;
  const [version, sha, ...rest] = parts;
  if (version === undefined || sha === undefined) return undefined;
  if (sha.length < 7 || !/^[0-9a-f]+$/i.test(sha)) return undefined;
  return { build, version, sha, channel: rest.join('-') };
}

/** Why the hub cannot say whether an update exists. Never rendered as "no". */
export type UpdateCheckError = 'offline' | 'rate_limited' | 'no_build_stamp';

export interface UpdateCheck {
  sha?: string;
  checkedAt?: string;
  error?: UpdateCheckError;
}

/**
 * The head of the branch this hub's builds come from.
 *
 * `Accept: application/vnd.github.sha` answers with the bare 40-character
 * commit rather than two kilobytes of JSON — worth the difference on a board
 * whose whole job is elsewhere. (Studio asks the same endpoint for the JSON;
 * if either changes, they still have to agree about the answer.)
 *
 * Deliberately *not* the rolling `bundle-main` release, which is what a Pi
 * actually downloads: CI has had that release's metadata lag its own assets by
 * days, and stale metadata would strand a hub on a permanent "update available"
 * that updating cannot clear. The branch head is wrong in the harmless
 * direction — it can offer an update a few minutes early, while CI is still
 * building it, and corrects itself on the next check.
 */
const HEAD_URL = 'https://api.github.com/repos/gethome-inc/gethome-hub/commits/main';
const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
/** A failed check is remembered too, so a hub with no internet answers fast. */
const FAILURE_TTL_MS = 5 * 60 * 1000;
/** Even an explicit refresh will not ask GitHub more often than this. */
const REFRESH_FLOOR_MS = 60 * 1000;

let cachedCheck: { check: UpdateCheck; at: number } | undefined;

/**
 * Asked only from `GET /system/update`, never on a timer: a hub nobody looks at
 * never calls out at all — the same rule `MqttObserver` follows for the broker
 * tap. Unauthenticated GitHub allows sixty requests an hour per address, and a
 * lazy call behind a six-hour cache is three orders of magnitude inside that.
 */
export async function checkForUpdate(refresh = false, now = Date.now()): Promise<UpdateCheck> {
  if (cachedCheck !== undefined) {
    const age = now - cachedCheck.at;
    const ttl = cachedCheck.check.error === undefined ? CHECK_TTL_MS : FAILURE_TTL_MS;
    if (age < (refresh ? REFRESH_FLOOR_MS : ttl)) return cachedCheck.check;
  }

  let check: UpdateCheck;
  try {
    const response = await fetch(HEAD_URL, {
      // Node's fetch would otherwise send `User-Agent: node`, which GitHub
      // accepts but which says nothing about who is calling; the API's own
      // guidance is to send something identifying.
      headers: { Accept: 'application/vnd.github.sha', 'User-Agent': 'gethome-hub' },
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 403 || response.status === 429) {
      check = { error: 'rate_limited' };
    } else if (!response.ok) {
      check = { error: 'offline' };
    } else {
      const sha = (await response.text()).trim();
      check = /^[0-9a-f]{7,40}$/i.test(sha)
        ? { sha: sha.slice(0, 7), checkedAt: new Date(now).toISOString() }
        : { error: 'offline' };
    }
  } catch {
    // No internet, DNS, a captive portal, a timeout. All one thing to a caller:
    // the hub cannot say, which is not the same as "you are up to date".
    check = { error: 'offline' };
  }
  cachedCheck = { check, at: now };
  return check;
}

/** Test seam — the cache is module state and a suite must be able to clear it. */
export function forgetUpdateCheck(): void {
  cachedCheck = undefined;
}

// ── Saying afterwards what happened ────────────────────────────────────────

/**
 * Write the outcome of a finished update to the activity log, once.
 *
 * The hub cannot record its own update while it happens — it is the thing being
 * restarted — so the runner's status file is read at the next boot and turned
 * into one row. `recorded` holds the id of the run already written, because
 * this runs on every start and a home does not want "the hub updated" again on
 * every reboot for the rest of the year.
 */
export async function recordFinishedUpdate(
  dataDir: string,
  activity: ActivityService,
  log: Logger,
): Promise<void> {
  const run = readUpdateRun(dataDir);
  if (run === undefined || run.state === 'running') return;

  const marker = path.join(updateDir(dataDir), 'recorded');
  try {
    if (readFileSync(marker, 'utf8').trim() === run.id) return;
  } catch {
    // Never recorded anything yet, which is the ordinary first time.
  }

  const build = run.liveBuild ?? run.fromBuild;
  const message =
    run.state === 'succeeded'
      ? `The hub updated to ${build}.`
      : run.state === 'rolled-back'
        ? `The hub update didn't work, so it went back to ${build} and is running again.`
        : run.state === 'stalled'
          ? `The hub update stopped before it finished.`
          : `The hub update didn't finish.`;

  try {
    await activity.record({
      kind: 'hub.update',
      message,
      data: {
        outcome: run.state,
        build,
        fromBuild: run.fromBuild,
        ...(run.error !== undefined ? { detail: run.error.slice(0, 300) } : {}),
      },
    });
    writeFileSync(marker, `${run.id}\n`, { mode: 0o644 });
  } catch (error) {
    // A hub that cannot write its own history still has to boot.
    log.warn({ err: error }, 'Could not record the outcome of the last update');
  }
}
