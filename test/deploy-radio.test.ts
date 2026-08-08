import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  /** `zigbee.env` as the script left it, or '' when it never wrote one. */
  zigbeeEnv: string;
  /** The device path the script settled on, from that file. */
  serialPort: string;
  /** Where the two env files live, so a test can look for what shouldn't. */
  confDir: string;
}

/**
 * A fake coordinator, staged the way a real one arrives.
 *
 * `GETHOME_ZIGBEE_SCAN_DIR` stands in for `/dev/serial/by-id`, and the file
 * name is a real SONOFF's, which `classify()` calls `certain` from the name
 * alone. Pinning would be the easier stage and is what this used to do — but
 * pinning is exactly the path that worked while the ordinary one silently
 * wrote nothing, so a test that pins proves the least interesting case.
 *
 * Passing a scan directory even when there is no coordinator is what makes
 * the suite hermetic: without it the script reads the *host's* `/dev`, and a
 * developer with a Zigbee stick in their laptop would see different results.
 */
const CERTAIN_NAME = 'usb-ITEAD_SONOFF_Zigbee_3.0_USB_Dongle_Plus_V2_20240122183357-if00';

function decide(options: {
  budget: 'one' | 'both';
  mode?: 'auto' | 'zigbee' | 'matter';
  coordinator: boolean;
  /** Stage it as an explicit `--zigbee` pin instead of a detected device. */
  pinned?: boolean;
}): Outcome {
  const conf = tmp();
  const data = tmp();
  const scan = tmp();
  writeFileSync(
    path.join(conf, 'hub.env'),
    // ADAPTER_MATTER starts at a value the script can never want, so a test
    // that passes proves the script wrote it rather than left it alone.
    `DATA_DIR=${data}\nGETHOME_RADIO=${options.budget}\nADAPTER_MATTER=9\n`,
  );
  if (options.mode) writeFileSync(path.join(data, 'radio-mode'), options.mode);
  if (options.coordinator) {
    const device = path.join(scan, CERTAIN_NAME);
    writeFileSync(device, '');
    if (options.pinned) {
      writeFileSync(path.join(conf, 'zigbee.env'), `GETHOME_ZIGBEE_PINNED=${device}\n`);
    }
  }

  let exitCode = 0;
  try {
    execFileSync('bash', [SCRIPT, '--quiet', '--no-start'], {
      env: { ...process.env, GETHOME_CONF: conf, GETHOME_ZIGBEE_SCAN_DIR: scan },
      stdio: 'ignore',
    });
  } catch (error) {
    exitCode = (error as { status?: number }).status ?? -1;
  }
  const env = readFileSync(path.join(conf, 'hub.env'), 'utf8');
  const matter = /^ADAPTER_MATTER=(.*)$/m.exec(env.split('\n').reverse().join('\n'))?.[1] ?? '';
  let zigbeeEnv = '';
  try {
    zigbeeEnv = readFileSync(path.join(conf, 'zigbee.env'), 'utf8');
  } catch {
    // Never written — which is the failure this file exists to catch.
  }
  const serialPort = /^ZIGBEE2MQTT_CONFIG_SERIAL_PORT=(.*)$/m.exec(zigbeeEnv)?.[1] ?? '';
  return { matter, exitCode, zigbeeEnv, serialPort, confDir: conf };
}

describe('a board that affords one radio', () => {
  it('runs Matter when no coordinator is plugged in', () => {
    // The bug this fixes: the installer switched Matter off on every board
    // under 1 GB, so a Zero 2 W with no stick ran neither radio and reserved
    // 150 MB for a Zigbee2MQTT that was never started.
    expect(decide({ budget: 'one', coordinator: false })).toMatchObject({ matter: '1', exitCode: 1 });
  });

  it('gives the board to Zigbee once a coordinator appears', () => {
    expect(decide({ budget: 'one', mode: 'auto', coordinator: true })).toMatchObject({
      matter: '0',
      exitCode: 0,
    });
  });

  it('keeps Matter when the owner picked it, even with a coordinator plugged in', () => {
    expect(decide({ budget: 'one', mode: 'matter', coordinator: true })).toMatchObject({
      matter: '1',
      exitCode: 1,
    });
  });

  it('still runs Matter when the owner picked Zigbee but has not plugged a stick in', () => {
    // Otherwise the hub talks to nothing at all: no Zigbee because there is no
    // coordinator, no Matter because the memory was reserved for one.
    expect(decide({ budget: 'one', mode: 'zigbee', coordinator: false })).toMatchObject({
      matter: '1',
      exitCode: 1,
    });
  });
});

describe('a board that affords both', () => {
  it('runs Matter and Zigbee together', () => {
    expect(decide({ budget: 'both', mode: 'auto', coordinator: true })).toMatchObject({
      matter: '1',
      exitCode: 0,
    });
  });

  it('honours an owner who wants Zigbee alone', () => {
    expect(decide({ budget: 'both', mode: 'zigbee', coordinator: true })).toMatchObject({
      matter: '0',
      exitCode: 0,
    });
  });

  it('honours an owner who wants Matter alone, leaving the coordinator configured', () => {
    expect(decide({ budget: 'both', mode: 'matter', coordinator: true })).toMatchObject({
      matter: '1',
      exitCode: 1,
    });
  });
});

describe('recording the coordinator', () => {
  /**
   * The regression this file was extended for.
   *
   * The write was `{ … [[ -n "$PINNED" ]] && echo … } > tmp && mv tmp real`.
   * A group's exit status is its last command's, so with nothing pinned the
   * group returned 1, the `mv` never ran, and `zigbee.env` was never created —
   * leaving a perfect config in `zigbee.env.tmp` and one line of evidence,
   * `chmod: cannot access …`. Zigbee2MQTT's EnvironmentFile is optional by
   * design, so it started, found no serial port, and never reached the stick:
   * a hub whose coordinator was correctly identified sat at
   * `zigbee.connected: false` forever.
   *
   * Nothing pinned is the *ordinary* install — every one that doesn't pass
   * `--zigbee`.
   */
  it('writes the serial port for a detected coordinator with nothing pinned', () => {
    const outcome = decide({ budget: 'both', coordinator: true });
    expect(outcome.serialPort, 'zigbee.env must name the device').toContain(CERTAIN_NAME);
    expect(outcome.zigbeeEnv).toContain('ZIGBEE_ADAPTER=');
    expect(outcome.exitCode, 'Zigbee is running').toBe(0);
  });

  it('writes it for a pinned coordinator too', () => {
    const outcome = decide({ budget: 'both', coordinator: true, pinned: true });
    expect(outcome.serialPort).toContain(CERTAIN_NAME);
    expect(outcome.zigbeeEnv).toContain('GETHOME_ZIGBEE_PINNED=');
  });

  it('records the device even when Matter is the radio this board runs', () => {
    // Switching back must not need a replug, so the path is written before
    // Zigbee2MQTT is refused the board.
    const outcome = decide({ budget: 'one', mode: 'matter', coordinator: true });
    expect(outcome.serialPort).toContain(CERTAIN_NAME);
    expect(outcome.matter, 'Matter keeps the board').toBe('1');
    expect(outcome.exitCode, 'Zigbee is genuinely not running').toBe(1);
  });

  it('leaves no temp file behind', () => {
    // The failure mode wrote zigbee.env.tmp and stopped there, so a stray temp
    // file beside the real one is the fingerprint of it coming back.
    const outcome = decide({ budget: 'both', coordinator: true });
    expect(outcome.serialPort).not.toBe('');
    expect(existsSync(path.join(outcome.confDir, 'zigbee.env.tmp'))).toBe(false);
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
        env: { ...process.env, GETHOME_CONF: conf, GETHOME_ZIGBEE_SCAN_DIR: tmp() },
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
        env: { ...process.env, GETHOME_CONF: conf, GETHOME_ZIGBEE_SCAN_DIR: tmp() },
        stdio: 'ignore',
      });
    } catch {
      /* exit 1 with no coordinator is the documented result */
    }
    // Falls back to auto: nothing plugged in, so Matter gets the board.
    expect(readFileSync(path.join(conf, 'hub.env'), 'utf8')).toContain('ADAPTER_MATTER=1');
  });
});
