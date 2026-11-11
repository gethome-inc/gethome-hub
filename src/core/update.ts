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
export function requestUpdate(dataDir: string, id: string = randomUUID()): string {
  // An id can be handed in by a caller that has to write it down *before* the
  // request exists — the hub's automatic updates, whose request is what
  // restarts the process that would otherwise write it afterwards.
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
 * One question to GitHub's API, asked the way this hub always asks it.
 *
 * Both callers below go through here so they cannot drift apart on the parts
 * that are easy to get subtly wrong: who is calling, how long to wait, and —
 * the one that matters — a refusal told apart from no answer at all. The body
 * is read inside, so a connection that drops half way through is "offline"
 * too, and `read` answering `undefined` means GitHub said something this hub
 * cannot use, which is never a "no".
 */
async function askGitHub<T>(
  url: string,
  accept: string,
  read: (response: Response) => Promise<T | undefined>,
): Promise<{ answer: T } | { error: UpdateCheckError }> {
  try {
    const response = await fetch(url, {
      // Node's fetch would otherwise send `User-Agent: node`, which GitHub
      // accepts but which says nothing about who is calling; the API's own
      // guidance is to send something identifying.
      headers: { Accept: accept, 'User-Agent': 'gethome-hub' },
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 403 || response.status === 429) return { error: 'rate_limited' };
    if (!response.ok) return { error: 'offline' };
    const answer = await read(response);
    return answer === undefined ? { error: 'offline' } : { answer };
  } catch {
    // No internet, DNS, a captive portal, a timeout. All one thing to a caller:
    // the hub cannot say, which is not the same as "you are up to date".
    return { error: 'offline' };
  }
}

/** A commit as this hub carries one — seven characters — or nothing, if it is not one. */
function shortSha(raw: string): string | undefined {
  return /^[0-9a-f]{7,40}$/i.test(raw) ? raw.slice(0, 7) : undefined;
}

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

  const asked = await askGitHub(HEAD_URL, 'application/vnd.github.sha', async (response) =>
    shortSha((await response.text()).trim()),
  );
  const check: UpdateCheck =
    'error' in asked ? { error: asked.error } : { sha: asked.answer, checkedAt: new Date(now).toISOString() };
  cachedCheck = { check, at: now };
  return check;
}

/** Test seam — the cache is module state and a suite must be able to clear it. */
export function forgetUpdateCheck(): void {
  cachedCheck = undefined;
}

/**
 * Whether two commits are the same one.
 *
 * A build stamp carries seven characters and GitHub can answer with forty, so
 * these are compared by prefix in whichever direction is shorter. Same test
 * Studio makes.
 */
export function sameCommit(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

/** `main`'s newest commit and when it landed there, or why the hub cannot say. */
export interface HeadCommit {
  sha?: string;
  /** Epoch ms. The committer's date, which for a merged pull request is the merge. */
  committedAt?: number;
  error?: UpdateCheckError;
}

/**
 * The same head, asked through the list of commits rather than the commit.
 *
 * An automatic update needs one thing the bare sha cannot say: **how long the
 * commit has been on `main`**, because merging is releasing and a build is
 * installed by itself only once it has been out for a day. `commits/main` would
 * answer that too, with the commit's whole file list attached — hundreds of
 * kilobytes after a large merge — while one entry of the list carries no files
 * and is a few kilobytes. Asked only by a hub whose owner switched automatic
 * updates on, once a night — and again that night only when GitHub did not
 * answer, half an hour later, or when a build it is waiting for comes of age
 * before the window closes.
 */
const HEAD_LIST_URL = 'https://api.github.com/repos/gethome-inc/gethome-hub/commits?sha=main&per_page=1';

const headListSchema = z.array(
  z.object({
    sha: z.string(),
    commit: z.object({
      committer: z.object({ date: z.string() }).nullish(),
    }),
  }),
);

export async function fetchHead(now = Date.now()): Promise<HeadCommit> {
  const asked = await askGitHub(HEAD_LIST_URL, 'application/vnd.github+json', async (response) => {
    const parsed = headListSchema.safeParse(await response.json());
    const first = parsed.success ? parsed.data[0] : undefined;
    const sha = first !== undefined ? shortSha(first.sha) : undefined;
    const committedAt = Date.parse(first?.commit.committer?.date ?? '');
    return sha !== undefined && Number.isFinite(committedAt) ? { sha, committedAt } : undefined;
  });
  if ('error' in asked) return { error: asked.error };
  // One answer for the whole hub: an app opening the Software card after a
  // night check sees what the night saw, without asking GitHub again.
  cachedCheck = { check: { sha: asked.answer.sha, checkedAt: new Date(now).toISOString() }, at: now };
  return asked.answer;
}

// ── Saying afterwards what happened ────────────────────────────────────────

/**
 * Write the outcome of a finished update to the activity log, once.
 *
 * The hub cannot record its own update while it happens — it is the thing being
 * restarted — so the runner's status file is turned into one row once it says
 * the run has ended (`watchUpdateOutcomes`, below). `recorded` holds the id of
 * the run already written, because that is asked again on every start and
 * every few minutes after, and a home does not want "the hub updated" again on
 * every reboot for the rest of the year.
 */
export async function recordFinishedUpdate(
  dataDir: string,
  activity: Pick<ActivityService, 'record'>,
  log: Logger,
  /**
   * The run the hub asked for by itself, if it asked for one.
   *
   * Its outcome is worded for what it was — nobody pressed anything, so "the
   * hub updated itself" is the sentence somebody needs a week later — and
   * carries `automatic`. The outcome words stay the same five, so an app built
   * before automatic updates still draws the row it always drew.
   */
  automaticRunId?: string,
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
  const automatic = automaticRunId !== undefined && automaticRunId === run.id;
  const message = automatic
    ? run.state === 'succeeded'
      ? `The hub updated itself to ${build}.`
      : run.state === 'rolled-back'
        ? `The hub's automatic update didn't work, so it went back to ${build} and is running again. ` +
          `It won't try that version by itself again.`
        : run.state === 'stalled'
          ? `The hub's automatic update stopped before it finished.`
          : `The hub's automatic update didn't finish.`
    : run.state === 'succeeded'
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
        ...(automatic ? { automatic: true } : {}),
        ...(run.error !== undefined ? { detail: run.error.slice(0, 300) } : {}),
      },
    });
    writeFileSync(marker, `${run.id}\n`, { mode: 0o644 });
  } catch (error) {
    // A hub that cannot write its own history still has to boot.
    log.warn({ err: error }, 'Could not record the outcome of the last update');
  }
}

/** How soon a run still in progress is looked at again. */
const SETTLING_LOOK_MS = 10 * 1000;

/**
 * How soon the status is looked at otherwise — for a run that ended without
 * restarting this process at all: a download that failed, another update
 * already holding the lock, a card with no room for the new build.
 */
const IDLE_LOOK_MS = 5 * 60 * 1000;

export interface UpdateOutcomeDeps {
  dataDir: string;
  activity: Pick<ActivityService, 'record'>;
  log: Logger;
  /**
   * Told about a run that has ended *before* its row is written, so whatever
   * keeps books on runs — the hub's own updates, which never try a build again
   * that rolled back on them — is settled first.
   */
  ended?: (run: UpdateRun) => Promise<void>;
  /** The run the hub last asked for by itself, so its row is worded that way. */
  automaticRunId?: () => string | undefined;
  now?: () => number;
  settlingMs?: number;
  idleMs?: number;
}

export interface UpdateOutcomeWatch {
  /** Look now, and keep looking. */
  start(): void;
  stop(): void;
  /** One look. Public so a test can drive it. Answers whether a run is still going. */
  check(): Promise<boolean>;
}

/**
 * Hear how an update ended — which is never at the boot that follows it.
 *
 * The runner writes its last word *after* the hub has come back: the installer
 * restarts the hub, waits for its health check (or, for a rollback, flips back
 * and restarts the old build), and only then does the runner ask the hub what
 * it is running and write `succeeded` or `rolled-back`. So the boot that
 * follows an update always finds `running`, and reading the file once at boot
 * — which is all this hub used to do — wrote nothing then, and nothing ever
 * once the next update overwrote the file. With automatic updates that is the
 * ordinary path: a rollback nobody wrote down was a build tried again the next
 * night, and the next.
 *
 * So the file is looked at every ten seconds while a run is going and every
 * five minutes otherwise — one small read, from the page cache, of a file this
 * hub's own directory holds. A run is written down once (`recordFinishedUpdate`
 * keeps the id), and `ended` hears every look at a finished run, so it has to
 * be as idempotent as that is.
 */
export function watchUpdateOutcomes(deps: UpdateOutcomeDeps): UpdateOutcomeWatch {
  const now = deps.now ?? (() => Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let looking: Promise<boolean> | undefined;

  async function look(): Promise<boolean> {
    const run = readUpdateRun(deps.dataDir, now());
    if (run === undefined) return false;
    if (run.state === 'running') return true;
    try {
      await deps.ended?.(run);
    } catch (error) {
      deps.log.warn({ err: error }, 'Could not settle the bookkeeping for the last update');
    }
    await recordFinishedUpdate(deps.dataDir, deps.activity, deps.log, deps.automaticRunId?.());
    return false;
  }

  // One look at a time: two at once could both find the same run unwritten.
  function check(): Promise<boolean> {
    looking ??= look().finally(() => {
      looking = undefined;
    });
    return looking;
  }

  function next(stillGoing: boolean): void {
    if (!running) return;
    timer = setTimeout(
      () => {
        void check().then(next, () => next(false));
      },
      stillGoing ? (deps.settlingMs ?? SETTLING_LOOK_MS) : (deps.idleMs ?? IDLE_LOOK_MS),
    );
    // Never the reason the process stays up.
    timer.unref?.();
  }

  return {
    start() {
      if (running) return;
      running = true;
      void check().then(next, () => next(false));
    },
    stop() {
      running = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    check,
  };
}
