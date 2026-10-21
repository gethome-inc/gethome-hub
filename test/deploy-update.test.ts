import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `deploy/update-runner.sh` — the half of "update my hub from the app" that
 * runs as root.
 *
 * The hub writes a run id into its own data directory, a `.path` unit notices,
 * and this script does the work. `deploy/` has no type checker behind it, so
 * this drives the real script against staged directories and a fake
 * `gethome-hubctl` on PATH, the way `deploy-radio.test.ts` drives the detector.
 *
 * What is worth pinning here is not "does it call the installer" — it is the
 * three outcomes, because two of them look identical from the exit status.
 */

const SCRIPT = path.resolve(import.meta.dirname, '../deploy/update-runner.sh');
const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gethome-update-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const OLD_BUILD = '0.1.0-aaaaaaa-main';
const NEW_BUILD = '0.1.0-bbbbbbb-main';

interface Status {
  id: string;
  state: string;
  step: string;
  fromBuild: string;
  liveBuild?: string;
  finishedAt?: string;
  heartbeat: string;
  error?: string;
  warnings: string[];
  hubAnswering: boolean;
}

interface Outcome {
  status: Status | undefined;
  log: string;
  exitCode: number;
  requestSurvived: boolean;
  updateDir: string;
}

/**
 * Run the real script with a staged machine around it.
 *
 * `hubctl` is the whole installer as far as this script is concerned, so a test
 * writes the marker stream it wants and the exit status that goes with it —
 * which is exactly how the interesting cases differ. `hubAnswers` stands in for
 * the hub's own API afterwards: a rollback leaves the *old* build answering, a
 * failure may leave nothing answering at all.
 */
function runUpdate(options: {
  id?: string;
  /** Explicitly undefined-able: "this machine has no gethome-hubctl" is a case. */
  hubctl?: string | undefined;
  hubAnswers?: string | null;
  /** Plant a name in <data>/update as a symlink before the run, to prove root
   *  does not follow it. The target is whatever the test wants left untouched. */
  plantLink?: { name: string; target: string };
}): Outcome {
  const conf = tmp();
  const data = tmp();
  const bin = tmp();
  const opt = tmp();

  const releases = path.join(opt, 'releases');
  mkdirSync(path.join(releases, OLD_BUILD), { recursive: true });
  symlinkSync(path.join(releases, OLD_BUILD), path.join(opt, 'current'));

  writeFileSync(path.join(conf, 'hub.env'), `DATA_DIR=${data}\nPORT=8420\n`);
  const updateDir = path.join(data, 'update');
  mkdirSync(updateDir, { recursive: true });

  if (options.hubctl !== undefined) {
    writeFileSync(path.join(bin, 'gethome-hubctl'), options.hubctl, { mode: 0o755 });
  }
  // The build the hub reports once it is up again — or nothing, for a hub that
  // never came back.
  const answers = options.hubAnswers === undefined ? NEW_BUILD : options.hubAnswers;
  writeFileSync(
    path.join(bin, 'curl'),
    answers === null
      ? '#!/usr/bin/env bash\nexit 7\n'
      : `#!/usr/bin/env bash\nprintf '{"hubId":"h","name":"Home","version":"0.1.0","build":"%s","apiVersion":1}\\n' ${JSON.stringify(answers)}\n`,
    { mode: 0o755 },
  );

  if (options.plantLink !== undefined) {
    symlinkSync(options.plantLink.target, path.join(updateDir, options.plantLink.name));
  }

  const id = options.id ?? 'run-0123456789abcdef';
  writeFileSync(path.join(updateDir, 'request'), `${id}\n`);

  let exitCode = 0;
  try {
    execFileSync('bash', [SCRIPT], {
      env: {
        ...process.env,
        GETHOME_CONF: conf,
        GETHOME_DIR: opt,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        // The script reads and writes <data>/update as the hub's account, and
        // the staged directory belongs to whoever runs the suite, so that is
        // the account — test/helpers/fake-nmcli.ts's reasoning. Without it a
        // suite running as root (a container, a CI image) asks for a `gethome`
        // account that is not there, and every write to <data> fails.
        GETHOME_USER: userInfo().username,
        // The real wait is thirty attempts two seconds apart, because a Zero 2 W
        // takes over a minute to come back. A test must not.
        GETHOME_UPDATE_SETTLE_TRIES: '2',
        GETHOME_UPDATE_SETTLE_SLEEP: '0',
      },
      stdio: 'ignore',
    });
  } catch (error) {
    exitCode = (error as { status?: number }).status ?? -1;
  }

  let status: Status | undefined;
  try {
    status = JSON.parse(readFileSync(path.join(updateDir, 'status.json'), 'utf8')) as Status;
  } catch {
    // Never written — which for most of these is the failure being caught.
  }
  let log = '';
  try {
    log = readFileSync(path.join(updateDir, 'last.log'), 'utf8');
  } catch {
    /* likewise */
  }
  return {
    status,
    log,
    exitCode,
    requestSurvived: existsSync(path.join(updateDir, 'request')),
    updateDir,
  };
}

/** An installer that prints the real marker vocabulary and succeeds. */
const HAPPY = `#!/usr/bin/env bash
echo "==> Updating from branch main…"
for s in system runtime download zigbee start autostart health; do printf '@@STEP:%s@@\\n' "$s"; done
printf '@@WARN:%s@@\\n' "Zigbee2MQTT never reached its coordinator."
echo "@@DONE@@"
exit 0
`;

describe('an update that works', () => {
  it('records the build the hub is actually running afterwards', () => {
    const { status, exitCode } = runUpdate({ hubctl: HAPPY });
    expect(exitCode).toBe(0);
    expect(status).toMatchObject({
      state: 'succeeded',
      fromBuild: OLD_BUILD,
      // Read back from the hub's own API, never from the log: the log says what
      // was attempted, the API says what is live.
      liveBuild: NEW_BUILD,
      hubAnswering: true,
    });
    expect(status?.finishedAt, 'a finished run says when').toBeTruthy();
  });

  it('keeps the installer warnings, which are the half nobody else reports', () => {
    // A hub is fine without Zigbee, so a coordinator that did not come up is a
    // warning and the install still succeeds — and a warning dropped here is
    // one the owner never sees, because the installer's output is gone.
    const { status } = runUpdate({ hubctl: HAPPY });
    expect(status?.warnings).toEqual(['Zigbee2MQTT never reached its coordinator.']);
  });

  it('follows the installer through its steps', () => {
    const { log } = runUpdate({ hubctl: HAPPY });
    expect(log).toContain('@@STEP:download@@');
    expect(log).toContain('@@DONE@@');
  });
});

describe('an update that put itself back', () => {
  /**
   * The case this file mainly exists for.
   *
   * `install.sh` rolls back by itself when the new build won't answer, and then
   * ends in `fail()` — a non-zero exit and an `@@ERROR@@` — exactly like an
   * update that broke the hub. `current` also points at the same build either
   * way, because that is what a rollback *is*. So without `@@ROLLBACK@@` the
   * app would tell somebody their hub is broken while it is running perfectly
   * on the build it started on.
   */
  const ROLLED_BACK = `#!/usr/bin/env bash
printf '@@STEP:%s@@\\n' download
printf '@@STEP:%s@@\\n' health
printf '@@ROLLBACK:%s@@\\n' ${JSON.stringify(OLD_BUILD)}
printf '@@ERROR:%s@@\\n' "Build ${NEW_BUILD} wouldn't start, so the hub was put back on the previous build and is running again. Nothing was lost."
exit 1
`;

  it('is not reported as a failure', () => {
    const { status } = runUpdate({ hubctl: ROLLED_BACK, hubAnswers: OLD_BUILD });
    expect(status?.state).toBe('rolled-back');
  });

  it('says the hub is up, on the build it started on', () => {
    const { status } = runUpdate({ hubctl: ROLLED_BACK, hubAnswers: OLD_BUILD });
    expect(status).toMatchObject({ hubAnswering: true, liveBuild: OLD_BUILD, fromBuild: OLD_BUILD });
    expect(status?.error, "the installer's own sentence, not ours").toContain('Nothing was lost');
  });
});

describe('an update that broke', () => {
  const BROKEN = `#!/usr/bin/env bash
printf '@@STEP:%s@@\\n' download
printf '@@ERROR:%s@@\\n' "The download failed: there is no space left on the card."
exit 1
`;

  it('is a failure, and says the hub is not answering', () => {
    const { status } = runUpdate({ hubctl: BROKEN, hubAnswers: null });
    expect(status).toMatchObject({ state: 'failed', hubAnswering: false });
    expect(status?.error).toContain('no space left');
  });

  it('names the reason the installer gave rather than an exit code', () => {
    // By the time anyone reads this the reason is a hundred lines up a log on a
    // machine they are not looking at.
    const { status } = runUpdate({ hubctl: BROKEN, hubAnswers: null });
    expect(status?.error).not.toMatch(/exit/i);
  });
});

describe('the request', () => {
  it('is consumed before any work, so a run cannot repeat itself', () => {
    // The file is what re-arms the path unit. One left behind by a run that
    // died would be picked up again on the next write to that directory.
    const { requestSurvived } = runUpdate({ hubctl: HAPPY });
    expect(requestSurvived).toBe(false);
  });

  it('carries into the status, so an app can tell its own run from another', () => {
    const { status } = runUpdate({ hubctl: HAPPY, id: 'run-cafebabecafebabe' });
    expect(status?.id).toBe('run-cafebabecafebabe');
  });

  it('is ignored when it is not an id, and still cleared', () => {
    const outcome = runUpdate({ hubctl: HAPPY, id: '   ' });
    expect(outcome.exitCode, 'nothing to do is not a failure').toBe(0);
    expect(outcome.status, 'no run was started, so no run is reported').toBeUndefined();
    expect(outcome.requestSurvived).toBe(false);
  });
});

describe('a machine that cannot update itself', () => {
  it('says so instead of filling the log with a shell error', () => {
    // A hub installed before any of this exists has no gethome-hubctl. The API
    // refuses earlier than this, so reaching here means something is odd — and
    // "command not found" is not an answer anybody can act on.
    const { status } = runUpdate({ hubctl: undefined });
    expect(status?.state).toBe('failed');
    expect(status?.error).toContain('gethome-hubctl');
  });
});

describe('the unit this runs as', () => {
  /**
   * Every outcome exits zero, including the failures.
   *
   * The unit's job is to run the update and write down what happened, and it
   * does that whether the update worked or not. A non-zero exit parks
   * `gethome-update.service` in `failed`; enough of those inside systemd's
   * start-limit window and the unit refuses to start at all until somebody runs
   * `reset-failed` on a machine the owner is not sitting at — the exact repair
   * `zigbee-detect.sh` already has to perform for Zigbee2MQTT. A rolled-back
   * update is not a failed unit: the hub is up and running perfectly well.
   */
  it.each([
    ['a clean update', HAPPY, NEW_BUILD],
    [
      'one that rolled back',
      `#!/usr/bin/env bash\nprintf '@@ROLLBACK:%s@@\\n' ${JSON.stringify(OLD_BUILD)}\nprintf '@@ERROR:%s@@\\n' "it wouldn't start"\nexit 1\n`,
      OLD_BUILD,
    ],
    [
      'one that broke',
      `#!/usr/bin/env bash\nprintf '@@ERROR:%s@@\\n' "the card is full"\nexit 1\n`,
      null,
    ],
    // The fourth outcome, and the one that most wants the rule: a machine with
    // no gethome-hubctl is a machine somebody presses the button on twice.
    ['a machine that cannot update itself', undefined, null],
  ])('exits zero after %s', (_name, hubctl, answers) => {
    const { exitCode } = runUpdate({
      ...(hubctl !== undefined ? { hubctl: hubctl as string } : {}),
      hubAnswers: answers as string | null,
    });
    expect(exitCode).toBe(0);
  });

  it('leaves no half-written status behind', () => {
    // status.json is renamed into place rather than written over, because the
    // hub reads it at any moment and a torn multi-field record can parse into
    // something that is confidently wrong.
    const { updateDir } = runUpdate({ hubctl: HAPPY });
    expect(existsSync(path.join(updateDir, 'status.json.tmp'))).toBe(false);
  });
});

describe('an installer that never started', () => {
  /**
   * `gethome-hubctl update` refuses before `install.sh` runs when another
   * update holds the lock — Studio updating over SSH at the same moment — or
   * when the installer download comes back empty. Neither prints a marker, so
   * without this the status would say "failed" and nothing else.
   */
  it("carries hubctl's own refusal rather than saying nothing", () => {
    const { status } = runUpdate({
      hubctl: `#!/usr/bin/env bash
echo "gethome-hubctl: another update is already running on this hub. Wait for it to finish." >&2
exit 1
`,
      hubAnswers: OLD_BUILD,
    });
    expect(status?.state).toBe('failed');
    expect(status?.error).toContain('another update is already running');
  });
});

describe('root, in the hub’s own data directory', () => {
  /**
   * The runner is root, `Type=oneshot`, with no sandboxing, and everything it
   * reads or writes in `<data>/update` is a name the hub's unprivileged account
   * owns. Root opening one follows whatever the account planted there — a
   * `last.log` linked to `/etc/profile.d/x.sh`, say, into which root then writes
   * the installer's output. So every one of those reads and writes is done as
   * the account (`as_hub`), the rule `deploy/wifi-networks.sh` already follows.
   * Pinned against the source, because this only ever runs for real on a Pi.
   */
  it('routes every <data> read and write through as_hub, with no chmod through a path', () => {
    const script = readFileSync(SCRIPT, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    // No chmod at all — a chmod follows a planted link to the target's mode, and
    // the hub's own files take their mode from the account's umask instead.
    expect(script).not.toMatch(/\bch(mod|own|grp)\b/);
    // The request, the status file and the log all go through the account.
    expect(script).toMatch(/as_hub cat "\$REQUEST"/);
    expect(script).toMatch(/as_hub rm -f "\$REQUEST"/);
    expect(script).toMatch(/\| as_hub sh -c/); // status.json, whole-file + rename
    expect(script).toMatch(/as_hub sh -c 'cat >> "\$1"'/); // log_line
    expect(script).toMatch(/as_hub sh -c 'umask 022; : > "\$1"'/); // the log truncate
    expect(script).toMatch(/setpriv --reuid=/);
    // And root does not reach into the log or status itself any more.
    expect(script).not.toMatch(/[^_]> "\$LOG_FILE"/);
    expect(script).not.toMatch(/>> "\$LOG_FILE"/);
    expect(script).not.toMatch(/> "\$STATUS_FILE\.tmp"/);
    expect(script).not.toMatch(/< "\$REQUEST"/);
  });

  /**
   * And shown, not just read: plant the status writer's *old* fixed temp name as
   * a link to a file outside the directory and run a clean update. The old code
   * wrote the status through `status.json.tmp` and `chmod`-ed it, so a link
   * there handed root's pen to the target; the new writer uses a pid-suffixed
   * temp it creates itself and renames into place, so the planted name is never
   * opened and the target keeps its content and its mode. Run as the same user
   * the test suite is — `as_hub` runs the command directly, or through
   * `setpriv` as that same account when the suite is root — so what this
   * proves is the *mechanism* (a name root no longer writes through), not the
   * privilege drop that backs it on the Pi.
   */
  it('does not write through a link left where its temp file used to be', () => {
    const outside = tmp();
    const sentinel = path.join(outside, 'root-only');
    writeFileSync(sentinel, 'KEEP\n');
    chmodSync(sentinel, 0o600);

    const { status, updateDir } = runUpdate({
      hubctl: HAPPY,
      plantLink: { name: 'status.json.tmp', target: sentinel },
    });

    // The update still ran and wrote its status the new way.
    expect(status?.state).toBe('succeeded');
    // The planted name was never followed: the target is untouched, content and
    // mode both. (The old code clobbered the content and chmod-ed it to 0644.)
    expect(readFileSync(sentinel, 'utf8')).toBe('KEEP\n');
    expect(statSync(sentinel).mode & 0o777).toBe(0o600);
    // The link is still a link where it was planted — nothing wrote through it,
    // and nothing renamed it onto status.json the way the old temp name was.
    expect(lstatSync(path.join(updateDir, 'status.json.tmp')).isSymbolicLink()).toBe(true);
  });
});
