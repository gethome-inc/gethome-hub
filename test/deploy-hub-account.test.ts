import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * **What root does inside the hub account's directories: nothing of its own.**
 *
 * `/var/lib/gethome` belongs to the unprivileged account the hub runs as, so
 * every name in it is whatever that account made it, and root following one
 * follows whatever was planted there. The update runner, the Wi-Fi script and
 * the installer's `<data>` writes already keep to that (`deploy-update`,
 * `deploy-wifi-networks`, `deploy-config`); this is the rest of it —
 * Zigbee2MQTT's `configuration.yaml`, which the installer edits, and the
 * pairing code `gethome-hubctl` reads.
 *
 * The Zigbee2MQTT half was also a data-loss bug, and that is the half these
 * runs are shaped around. Its checks ran as whoever ran the installer, and for
 * `curl … | bash` or `gethome-hubctl update` without sudo that is a login user
 * who cannot see into `/var/lib/gethome` once the installer has made it 0750 —
 * measured on a Zero 2 W — so an existing configuration looked absent and was
 * written over with a fresh one: network key, PAN IDs and channel gone.
 *
 * These run the installer's real functions with a fake `sudo` that records
 * every command it is asked to run as root and a fake `setpriv` that runs the
 * rest as the caller, so the question "what did root do itself" has a literal
 * answer: every root command has to be `setpriv` dropping to the hub's
 * account. A test cannot switch users, which is why that, rather than a
 * permission error, is the thing pinned.
 */

const repoRoot = path.join(import.meta.dirname, '..');
const INSTALLER = path.join(repoRoot, 'deploy', 'install.sh');
const HUBCTL = path.join(repoRoot, 'deploy', 'gethome-hubctl');
const installer = readFileSync(INSTALLER, 'utf8');
const hubctl = readFileSync(HUBCTL, 'utf8');
const dirs: string[] = [];
const uid = execFileSync('id', ['-u'], { encoding: 'utf8' }).trim();
const gid = execFileSync('id', ['-g'], { encoding: 'utf8' }).trim();
const AS_HUB = `setpriv --reuid=${uid} --regid=${gid} --clear-groups -- `;

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function script_(file: string, body: string): void {
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

/**
 * A `bin` directory holding the fake `sudo` (logs, then runs the command) and
 * the fake `setpriv` (drops its options, then runs the command as the caller —
 * or, with `LIE_EXISTS` set, answers "absent" to `test -e`, which is how a test
 * stands in for a check that cannot see what is there).
 */
function fakes(dir: string): { bin: string; log: string } {
  const bin = path.join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = path.join(dir, 'sudo.log');
  writeFileSync(log, '');
  script_(path.join(bin, 'sudo'), 'printf \'%s\\n\' "$*" >> "$SUDO_LOG"\nexec "$@"');
  script_(
    path.join(bin, 'setpriv'),
    [
      'while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done',
      '[ $# -gt 0 ] && shift',
      'if [ -n "${LIE_EXISTS:-}" ] && [ "$1" = "test" ] && [ "$2" = "-e" ]; then exit 1; fi',
      'exec "$@"',
    ].join('\n'),
  );
  // No default route: the channel picked for a new network is the no-Wi-Fi one.
  script_(path.join(bin, 'ip'), 'exit 0');
  return { bin, log };
}

/** Everything the run asked `sudo` to do, one command per entry. */
function sudoLog(log: string): string[] {
  return readFileSync(log, 'utf8').split('\n').filter((line) => line !== '');
}

interface Onboarding {
  output: string;
  changed: boolean;
  /** configuration.yaml afterwards, or undefined when there is none. */
  config: string | undefined;
  sudo: string[];
  dir: string;
}

/**
 * Run `z2m_onboarding_off` out of install.sh against a Zigbee2MQTT data
 * directory the test owns.
 */
function onboarding(options: {
  config?: string;
  backup?: boolean;
  mode?: number;
  /** Make configuration.yaml a link to a file outside the directory holding this. */
  link?: string;
  lieExists?: boolean;
}): Onboarding {
  const dir = scratch('gethome-z2m-');
  const { bin, log } = fakes(dir);
  const data = path.join(dir, 'zigbee2mqtt');
  mkdirSync(data);
  mkdirSync(path.join(dir, 'net'));
  const config = path.join(data, 'configuration.yaml');
  if (options.link !== undefined) {
    const outside = path.join(dir, 'victim');
    writeFileSync(outside, options.link);
    symlinkSync(outside, config);
  } else if (options.config !== undefined) {
    writeFileSync(config, options.config);
    if (options.mode !== undefined) chmodSync(config, options.mode);
  }
  if (options.backup === true) {
    writeFileSync(path.join(data, 'coordinator_backup.json'), '{"metadata":{"version":1},"logical_channel":11}\n');
  }

  const output = execFileSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
       SUDO=sudo
       SERVICE_USER="$(id -un)"
       Z2M_DATA_DIR="$2"
       Z2M_CONFIG="$2/configuration.yaml"
       Z2M_ONBOARDING_CHANGED=""
       say()  { printf 'SAY %s\\n' "$*"; }
       warn() { printf 'WARN %s\\n' "$*"; }
       for fn in as_service_user read_hub_file find_iw lan_wifi_iface wifi_frequency_mhz \\
                 zigbee_channel_clear_of_wifi z2m_onboarding_off replace_z2m_config; do
         prog="/^$fn() {/,/^}/p"
         eval "$(sed -n "$prog" "$1")"
       done
       z2m_onboarding_off
       printf 'CHANGED=%s\\n' "$Z2M_ONBOARDING_CHANGED"`,
      'bash',
      INSTALLER,
      data,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        SUDO_LOG: log,
        GETHOME_NET_DIR: path.join(dir, 'net'),
        ...(options.lieExists === true ? { LIE_EXISTS: '1' } : {}),
      },
    },
  );
  return {
    output,
    changed: output.includes('CHANGED=1'),
    config: existsSync(config) ? readFileSync(config, 'utf8') : undefined,
    sudo: sudoLog(log),
    dir,
  };
}

/** Every root command was setpriv dropping to the hub's account, and there was at least one. */
function expectOnlyAsHub(sudo: string[]): void {
  expect(sudo.length).toBeGreaterThan(0);
  for (const line of sudo) expect(line, line).toMatch(new RegExp(`^${AS_HUB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
}

const NETWORK = [
  'version: 5',
  'mqtt:',
  '  base_topic: zigbee2mqtt',
  'advanced:',
  '  channel: 11',
  '  network_key: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]',
  '  pan_id: 38830',
  '',
].join('\n');

describe('Zigbee2MQTT’s configuration.yaml', () => {
  it('is created on a hub that has never formed a network, as the hub’s account', () => {
    const run = onboarding({});
    expect(run.config).toBe('onboarding: false\nadvanced:\n  channel: 25\n');
    expect(run.changed).toBe(true);
    expect(run.output).toContain('channel 25');
    expectOnlyAsHub(run.sudo);
  });

  it('is created without a channel when a coordinator backup says a network exists', () => {
    // A backup with the config gone is a network whose channel is not ours to move.
    const run = onboarding({ backup: true });
    expect(run.config).toBe('onboarding: false\n');
    expect(run.output).not.toContain('channel');
    expectOnlyAsHub(run.sudo);
  });

  it('has its onboarding line replaced and nothing else, keeping its mode', () => {
    const before = `${NETWORK}onboarding: true\nfrontend:\n  enabled: false\n`;
    const run = onboarding({ config: before, mode: 0o600 });
    expect(run.config).toBe(`${NETWORK}onboarding: false\nfrontend:\n  enabled: false\n`);
    expect(run.changed).toBe(true);
    expect(statSync(path.join(run.dir, 'zigbee2mqtt', 'configuration.yaml')).mode & 0o777).toBe(0o600);
    // No temporary file left beside the network key.
    expect(readdirSync(path.join(run.dir, 'zigbee2mqtt'))).toEqual(['configuration.yaml']);
    expectOnlyAsHub(run.sudo);
  });

  it('gets the line added when it has none, on a line of its own', () => {
    expect(onboarding({ config: NETWORK }).config).toBe(`${NETWORK}onboarding: false\n`);
    // A file somebody saved without a final newline must not run the two together.
    const unterminated = NETWORK.slice(0, -1);
    expect(onboarding({ config: unterminated }).config).toBe(`${unterminated}\nonboarding: false\n`);
  });

  it('is left exactly as it was when it already says false', () => {
    const before = `${NETWORK}onboarding: false\n`;
    const run = onboarding({ config: before });
    expect(run.config).toBe(before);
    expect(run.changed).toBe(false);
    // Read, and not written: only `test` and `cat` went through root.
    for (const line of run.sudo) expect(line.slice(AS_HUB.length), line).toMatch(/^(test|cat) /);
  });

  /**
   * The property that makes the data-loss bug impossible rather than merely
   * fixed: creating is create-only, so a check that wrongly says "absent" —
   * which is exactly what the login user's check said — cannot cost a network.
   */
  it('is never replaced by a fresh one, even when the check says it is absent', () => {
    const before = `${NETWORK}onboarding: false\n`;
    const run = onboarding({ config: before, lieExists: true });
    expect(run.config).toBe(before);
    expect(run.changed).toBe(false);
  });

  it('is edited beside a link the account planted, never through it', () => {
    const run = onboarding({ link: 'root-only: yes\n' });
    // The file the link named is untouched; the link itself is what was replaced.
    expect(readFileSync(path.join(run.dir, 'victim'), 'utf8')).toBe('root-only: yes\n');
    expect(lstatSync(path.join(run.dir, 'zigbee2mqtt', 'configuration.yaml')).isSymbolicLink()).toBe(false);
    expectOnlyAsHub(run.sudo);
  });
});

describe('reading the Zigbee network’s channel', () => {
  function channel(files: { backup?: string; config?: string }): { channel: string; sudo: string[] } {
    const dir = scratch('gethome-z2m-channel-');
    const { bin, log } = fakes(dir);
    const data = path.join(dir, 'zigbee2mqtt');
    mkdirSync(data);
    if (files.backup !== undefined) writeFileSync(path.join(data, 'coordinator_backup.json'), files.backup);
    if (files.config !== undefined) writeFileSync(path.join(data, 'configuration.yaml'), files.config);
    const out = execFileSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
         SUDO=sudo
         SERVICE_USER="$(id -un)"
         Z2M_DATA_DIR="$2"
         Z2M_CONFIG="$2/configuration.yaml"
         for fn in as_service_user read_hub_file zigbee_network_channel; do
           prog="/^$fn() {/,/^}/p"
           eval "$(sed -n "$prog" "$1")"
         done
         zigbee_network_channel`,
        'bash',
        INSTALLER,
        data,
      ],
      { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SUDO_LOG: log } },
    );
    return { channel: out, sudo: sudoLog(log) };
  }

  it('reads the backup first, and the config after it, both as the hub’s account', () => {
    const fromBackup = channel({ backup: '{"logical_channel": 15}', config: 'advanced:\n  channel: 20\n' });
    expect(fromBackup.channel).toBe('15');
    expectOnlyAsHub(fromBackup.sudo);
    const fromConfig = channel({ config: 'advanced:\n  channel: 20\n' });
    expect(fromConfig.channel).toBe('20');
    expectOnlyAsHub(fromConfig.sudo);
  });

  it('says nothing for a hub with neither', () => {
    expect(channel({}).channel).toBe('');
  });
});

describe('install.sh in Zigbee2MQTT’s directory', () => {
  const zigbee = installer.slice(installer.indexOf('step zigbee '), installer.indexOf('step start '));

  /**
   * The static half, over the whole Zigbee step: nothing there touches the
   * directory as root except `chown -R`, which without -H or -L changes a link
   * itself and never descends through one — and nothing tests or reads a file
   * there in the installer's own name, which as the login user is a question
   * asked of a directory it cannot see into.
   */
  it('touches nothing there as root but `chown -R`, and checks nothing there in its own name', () => {
    expect(zigbee.length).toBeGreaterThan(1000);
    for (const line of zigbee.split('\n')) {
      if (/\$SUDO\b/.test(line) && /(Z2M_DATA_DIR|Z2M_CONFIG|backup)/.test(line)) {
        expect(line.trim(), line).toMatch(/^\$SUDO chown -R "\$SERVICE_USER:\$SERVICE_USER" "\$Z2M_DATA_DIR"$/);
      }
      expect(line, line).not.toMatch(/\[\[ [^\]]*-[efrs] "\$(Z2M_CONFIG|Z2M_DATA_DIR|backup)/);
      expect(line, line).not.toMatch(/^\s*(grep|sed|cat|tee)\b[^|]*"\$(Z2M_CONFIG|Z2M_DATA_DIR)/);
    }
    // And the old writes are gone for good.
    expect(installer).not.toMatch(/\$SUDO (tee|sed -i|chown)[^\n]*"\$Z2M_CONFIG"/);
  });

  it('reads the owner’s radio choice as the hub’s account too', () => {
    // An install run by the login user could not read <data>/radio-mode at all
    // (<data> is 0750) and told somebody who had chosen both radios that their
    // coordinator had the board.
    expect(installer).toMatch(/RADIO_MODE="\$\(read_hub_file "\$DATA_DIR\/radio-mode"/);
    expect(installer).not.toMatch(/< "\$DATA_DIR\/radio-mode"/);
  });
});

/**
 * `gethome-hubctl claim` reads `<data>/pairing-code` and sends it to the hub's
 * own port, and `pairing-code` prints it as a marker Studio reads. Read by root
 * through that path, a link the account planted there would be a read of any
 * root-only file, handed to whatever answers on the hub's port.
 */
describe('gethome-hubctl and the pairing code', () => {
  it('reads it as the hub’s account, in both places', () => {
    expect(hubctl.match(/read_hub_file "\$DATA_DIR\/pairing-code"/g)?.length).toBe(2);
    expect(hubctl).not.toMatch(/\$SUDO cat "\$DATA_DIR/);
  });

  it('drops to the hub’s account for every command it runs as root', () => {
    const dir = scratch('gethome-hubctl-code-');
    const { bin, log } = fakes(dir);
    const code = path.join(dir, 'pairing-code');
    writeFileSync(code, ' 123-456 \n');
    const out = execFileSync(
      'bash',
      [
        '-c',
        `set -uo pipefail
         SUDO=sudo
         HUB_USER="$(id -un)"
         for fn in as_hub read_hub_file; do
           prog="/^$fn() {/,/^}/p"
           eval "$(sed -n "$prog" "$1")"
         done
         read_hub_file "$2" | tr -d '[:space:]'`,
        'bash',
        HUBCTL,
        code,
      ],
      { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SUDO_LOG: log } },
    );
    expect(out).toBe('123-456');
    expectOnlyAsHub(sudoLog(log));
  });
});
