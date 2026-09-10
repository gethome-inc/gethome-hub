import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The two halves of pairing a Matter accessory that has never been on a
 * network, both of which live in `deploy/` because both need root.
 *
 * **Bluetooth**, because such an accessory advertises there and nowhere else —
 * and because Raspberry Pi OS ships a headless image with the radio
 * *soft-blocked* in rfkill, which is invisible from every surface the product
 * has: `hciconfig` lists the adapter, bringing it up fails with an errno
 * nothing logs, and the app says "Pairing with your hub" until somebody gives
 * up. Found on a real Zero 2 W, where `soft=1` was the whole of it.
 *
 * **The Wi-Fi password**, because taking an accessory on over Bluetooth means
 * handing it a network, and a hub that can do the first and not the second
 * starts a pairing it cannot finish.
 *
 * `deploy/` has no type checker behind it, so these run the installer's own
 * functions against a fake sysfs, a fake `nmcli` and files the test owns —
 * `deploy-wifi.test.ts`'s pattern, including its two portability rules: the
 * sed program is built into a variable first (bash 3.2 brace-expands it
 * otherwise) and nothing here reaches for a GNU-only idiom.
 */

const repoRoot = path.join(import.meta.dirname, '..');
const INSTALLER = path.join(repoRoot, 'deploy', 'install.sh');
const CREDENTIALS = path.join(repoRoot, 'deploy', 'wifi-credentials.sh');
const dirs: string[] = [];

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

interface BluetoothOutcome {
  output: string;
  /** The soft-block byte as the run left it, per adapter name. */
  soft: Record<string, string>;
  /** Every `systemctl` invocation, in order. */
  systemctl: string[];
}

/**
 * Run `matter_bluetooth` out of install.sh against a fake `/sys/class/rfkill`.
 *
 * `adapters` is name → {soft, hard}, so a test can stage the shipped-blocked
 * board, an already-open one, and a board whose radio is off at the hardware
 * switch — which must warn rather than silently pretend.
 */
function bluetooth(options: {
  adapters?: Record<string, { soft: string; hard: string }>;
  rfkillDir?: boolean;
  bluetoothStarts?: boolean;
}): BluetoothOutcome {
  const dir = scratch('gethome-ble-');
  const bin = path.join(dir, 'bin');
  const rfkill = path.join(dir, 'rfkill');
  const calls = path.join(dir, 'systemctl-calls');
  mkdirSync(bin, { recursive: true });

  const adapters = options.adapters ?? { hci0: { soft: '1', hard: '0' } };
  if (options.rfkillDir !== false) {
    mkdirSync(rfkill, { recursive: true });
    let index = 0;
    for (const [name, state] of Object.entries(adapters)) {
      const entry = path.join(rfkill, `rfkill${index}`);
      index += 1;
      mkdirSync(entry, { recursive: true });
      writeFileSync(path.join(entry, 'name'), `${name}\n`);
      writeFileSync(path.join(entry, 'soft'), state.soft);
      writeFileSync(path.join(entry, 'hard'), state.hard);
    }
  }

  script_(
    path.join(bin, 'systemctl'),
    `echo "$*" >> "${calls}"
     case "$1 $2" in "start bluetooth") [ "$FAKE_BLUETOOTH_STARTS" = "no" ] && exit 1 ;; esac
     exit 0`,
  );
  // `tee` is what writes the sysfs byte, and the real one is fine here — the
  // files are the test's own.
  const output = execFileSync(
    'bash',
    [
      '-c',
      `set -uo pipefail
       SUDO=""
       say()  { printf 'SAY %s\\n' "$*"; }
       warn() { printf 'WARN %s\\n' "$*"; }
       prog="/^matter_bluetooth() {/,/^}/p"
       eval "$(sed -n "$prog" "$1")"
       matter_bluetooth`,
      'bash',
      INSTALLER,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        GETHOME_RFKILL_DIR: rfkill,
        FAKE_BLUETOOTH_STARTS: options.bluetoothStarts === false ? 'no' : 'yes',
      },
    },
  );

  const soft: Record<string, string> = {};
  if (existsSync(rfkill)) {
    let index = 0;
    for (const name of Object.keys(adapters)) {
      const entry = path.join(rfkill, `rfkill${index}`);
      index += 1;
      soft[name] = readFileSync(path.join(entry, 'soft'), 'utf8').trim();
    }
  }
  return {
    output,
    soft,
    systemctl: existsSync(calls)
      ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean)
      : [],
  };
}

describe('turning Bluetooth on for Matter pairing', () => {
  it('unblocks the radio a headless Raspberry Pi image ships blocked', () => {
    const run = bluetooth({ adapters: { hci0: { soft: '1', hard: '0' } } });
    expect(run.soft.hci0).toBe('0');
    expect(run.systemctl).toContain('start bluetooth');
    expect(run.output).toContain('SAY Bluetooth is on');
  });

  it('leaves an already-open radio alone and still starts bluetoothd', () => {
    const run = bluetooth({ adapters: { hci0: { soft: '0', hard: '0' } } });
    expect(run.soft.hci0).toBe('0');
    expect(run.systemctl).toContain('start bluetooth');
  });

  it('asks for the state to survive a reboot', () => {
    // `rfkill unblock` does not persist on its own; systemd-rfkill saves what
    // it sees at shutdown, so enabling it is the persistence.
    const run = bluetooth({});
    expect(run.systemctl).toContain('enable systemd-rfkill');
    expect(run.systemctl).toContain('enable bluetooth');
  });

  it('says so when the radio is off at a hardware switch', () => {
    // Nothing software can do about it, so the only useful move is to name it
    // — and to say the rest of the hub is unaffected.
    const run = bluetooth({ adapters: { hci0: { soft: '0', hard: '1' } } });
    expect(run.output).toContain('WARN');
    expect(run.output).toContain('hardware switch');
    expect(run.systemctl).not.toContain('start bluetooth');
  });

  it('is quiet on a machine with no Bluetooth at all', () => {
    // A Pi with the radio disabled in config.txt, a VM, an x86 box. Ordinary
    // machines, not faults: the hub reports it on GET /hub and the app
    // explains it. A warning here would be a warning on every such install.
    expect(bluetooth({ rfkillDir: false }).output).toBe('');
    expect(bluetooth({ adapters: { phy0: { soft: '0', hard: '0' } } }).output).toBe('');
  });

  it('warns, rather than claiming success, when bluetoothd will not start', () => {
    const run = bluetooth({ bluetoothStarts: false });
    expect(run.output).toContain('WARN');
    expect(run.output).toContain('already on your network');
  });
});

interface CredentialsOutcome {
  output: string;
  file: string;
  mode: string;
}

/** Run `deploy/wifi-credentials.sh` against a fake `nmcli`. */
function credentials(options: {
  ssid?: string;
  psk?: string;
  active?: boolean;
  nmcli?: boolean;
}): CredentialsOutcome {
  const dir = scratch('gethome-wificreds-');
  const bin = path.join(dir, 'bin');
  const conf = path.join(dir, 'gethome');
  mkdirSync(bin, { recursive: true });
  mkdirSync(conf, { recursive: true });

  if (options.nmcli !== false) {
    script_(
      path.join(bin, 'nmcli'),
      `case "$*" in
         *"connection show --active"*) [ "$FAKE_ACTIVE" = "no" ] || printf 'abc-123:802-11-wireless\\n' ;;
         *"802-11-wireless.ssid"*)     printf '%s\\n' "$FAKE_SSID" ;;
         *"802-11-wireless-security.psk"*) printf '%s\\n' "$FAKE_PSK" ;;
       esac
       exit 0`,
    );
  }

  const output = execFileSync('bash', [CREDENTIALS, '--conf', conf], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FAKE_SSID: options.ssid ?? 'Flat 3',
      FAKE_PSK: options.psk ?? 'hunter2hunter2',
      FAKE_ACTIVE: options.active === false ? 'no' : 'yes',
      GETHOME_GROUP: 'staff',
      // A dispatcher sets this; without it the script asks nmcli which
      // connection carries the wireless link.
      CONNECTION_UUID: '',
    },
  });

  const file = path.join(conf, 'wifi.env');
  return {
    output,
    file: existsSync(file) ? readFileSync(file, 'utf8') : '',
    mode: existsSync(file) ? (statSync(file).mode & 0o777).toString(8) : '',
  };
}

describe('the Wi-Fi the hub passes on to an accessory', () => {
  it('records the network this hub is on', () => {
    const run = credentials({});
    expect(run.file).toContain("WIFI_SSID='Flat 3'");
    expect(run.file).toContain("WIFI_PSK='hunter2hunter2'");
    expect(run.output).toContain('Flat 3');
  });

  it('is readable by the group and nobody else', () => {
    // The hub's service account is the one that will send this over the air,
    // so it may read it. The rest of the machine may not.
    expect(credentials({}).mode).toBe('640');
  });

  it('quotes an SSID with an apostrophe in it', () => {
    // The file is shell-quoted on the way in because an SSID may contain a
    // space, so the one character that ends the quoting has to survive.
    const run = credentials({ ssid: "Dave's Wi-Fi" });
    expect(run.file).toContain("WIFI_SSID='Dave'\\''s Wi-Fi'");
  });

  it('writes an empty password for an open network rather than pretending', () => {
    // The hub reads that as "no credentials": an accessory handed an empty
    // password for a network it cannot join is worse than being told the hub
    // has none.
    const run = credentials({ psk: '' });
    expect(run.file).toContain("WIFI_PSK=''");
    expect(run.output).toContain('no password');
  });

  it('writes nothing on a wired hub, and says nothing alarming', () => {
    const run = credentials({ active: false });
    expect(run.file).toBe('');
    expect(run.output).toContain('not on Wi-Fi');
  });

  it('writes nothing on a machine with no NetworkManager', () => {
    const run = credentials({ nmcli: false });
    expect(run.file).toBe('');
    expect(run.output).toContain('No NetworkManager');
  });
});
