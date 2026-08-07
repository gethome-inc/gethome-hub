import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The radio decision in `deploy/zigbee-detect.sh`.
 *
 * That script decides which radio a board runs, and it is the only place the
 * decision exists — it is what runs at boot, on every USB plug and unplug, and
 * at the end of the install. `deploy/` has no type checker behind it, so this
 * exercises the real script rather than a copy of its rules.
 *
 * Two inputs, deliberately separate: the board's *budget* (`GETHOME_RADIO` in
 * hub.env — how many radios fit, measured, not chosen) and the owner's
 * *preference* (`<DATA_DIR>/radio-mode`, written by the hub when the owner
 * switches in the app).
 */

const SCRIPT = path.resolve(import.meta.dirname, '../deploy/zigbee-detect.sh');
const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gethome-radio-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

interface Outcome {
  /** What the script wrote back to hub.env. */
  matter: string;
  /** 0 when Zigbee is running, 1 when it is not — what install.sh reads. */
  exitCode: number;
}

function decide(options: {
  budget: 'one' | 'both';
  mode?: 'auto' | 'zigbee' | 'matter';
  coordinator: boolean;
}): Outcome {
  const conf = tmp();
  const data = tmp();
  writeFileSync(
    path.join(conf, 'hub.env'),
    // ADAPTER_MATTER starts at a value the script can never want, so a test
    // that passes proves the script wrote it rather than left it alone.
    `DATA_DIR=${data}\nGETHOME_RADIO=${options.budget}\nADAPTER_MATTER=9\n`,
  );
  if (options.mode) writeFileSync(path.join(data, 'radio-mode'), options.mode);
  if (options.coordinator) {
    // A pinned path that exists is adopted as a coordinator, which is how a
    // generic bridge gets used once a human has vouched for it — and the only
    // way to stage one of these on a machine with no Zigbee hardware.
    const fake = path.join(data, 'fake-coordinator');
    writeFileSync(fake, '');
    writeFileSync(path.join(conf, 'zigbee.env'), `GETHOME_ZIGBEE_PINNED=${fake}\n`);
  }

  let exitCode = 0;
  try {
    execFileSync('bash', [SCRIPT, '--quiet', '--no-start'], {
      env: { ...process.env, GETHOME_CONF: conf },
      stdio: 'ignore',
    });
  } catch (error) {
    exitCode = (error as { status?: number }).status ?? -1;
  }
  const env = readFileSync(path.join(conf, 'hub.env'), 'utf8');
  const matter = /^ADAPTER_MATTER=(.*)$/m.exec(env.split('\n').reverse().join('\n'))?.[1] ?? '';
  return { matter, exitCode };
}

describe('a board that affords one radio', () => {
  it('runs Matter when no coordinator is plugged in', () => {
    // The bug this fixes: the installer switched Matter off on every board
    // under 1 GB, so a Zero 2 W with no stick ran neither radio and reserved
    // 150 MB for a Zigbee2MQTT that was never started.
    expect(decide({ budget: 'one', coordinator: false })).toEqual({ matter: '1', exitCode: 1 });
  });

  it('gives the board to Zigbee once a coordinator appears', () => {
    expect(decide({ budget: 'one', mode: 'auto', coordinator: true })).toEqual({
      matter: '0',
      exitCode: 0,
    });
  });

  it('keeps Matter when the owner picked it, even with a coordinator plugged in', () => {
    expect(decide({ budget: 'one', mode: 'matter', coordinator: true })).toEqual({
      matter: '1',
      exitCode: 1,
    });
  });

  it('still runs Matter when the owner picked Zigbee but has not plugged a stick in', () => {
    // Otherwise the hub talks to nothing at all: no Zigbee because there is no
    // coordinator, no Matter because the memory was reserved for one.
    expect(decide({ budget: 'one', mode: 'zigbee', coordinator: false })).toEqual({
      matter: '1',
      exitCode: 1,
    });
  });
});

describe('a board that affords both', () => {
  it('runs Matter and Zigbee together', () => {
    expect(decide({ budget: 'both', mode: 'auto', coordinator: true })).toEqual({
      matter: '1',
      exitCode: 0,
    });
  });

  it('honours an owner who wants Zigbee alone', () => {
    expect(decide({ budget: 'both', mode: 'zigbee', coordinator: true })).toEqual({
      matter: '0',
      exitCode: 0,
    });
  });

  it('honours an owner who wants Matter alone, leaving the coordinator configured', () => {
    expect(decide({ budget: 'both', mode: 'matter', coordinator: true })).toEqual({
      matter: '1',
      exitCode: 1,
    });
  });
});

describe('defaults', () => {
  it('treats a hub.env with no budget as a board that affords both', () => {
    const conf = tmp();
    const data = tmp();
    writeFileSync(path.join(conf, 'hub.env'), `DATA_DIR=${data}\nADAPTER_MATTER=9\n`);
    let exitCode = 0;
    try {
      execFileSync('bash', [SCRIPT, '--quiet', '--no-start'], {
        env: { ...process.env, GETHOME_CONF: conf },
        stdio: 'ignore',
      });
    } catch (error) {
      exitCode = (error as { status?: number }).status ?? -1;
    }
    expect(readFileSync(path.join(conf, 'hub.env'), 'utf8')).toContain('ADAPTER_MATTER=1');
    expect(exitCode).toBe(1);
  });

  it('ignores an unreadable radio-mode rather than guessing', () => {
    const conf = tmp();
    const data = tmp();
    writeFileSync(path.join(conf, 'hub.env'), `DATA_DIR=${data}\nGETHOME_RADIO=one\nADAPTER_MATTER=9\n`);
    writeFileSync(path.join(data, 'radio-mode'), 'nonsense');
    try {
      execFileSync('bash', [SCRIPT, '--quiet', '--no-start'], {
        env: { ...process.env, GETHOME_CONF: conf },
        stdio: 'ignore',
      });
    } catch {
      /* exit 1 with no coordinator is the documented result */
    }
    // Falls back to auto: nothing plugged in, so Matter gets the board.
    expect(readFileSync(path.join(conf, 'hub.env'), 'utf8')).toContain('ADAPTER_MATTER=1');
  });
});
