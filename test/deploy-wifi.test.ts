import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The Wi-Fi power-save decision in `deploy/install.sh`.
 *
 * Found on a Zero 2 W whose owner could not reach the hub from the app or over
 * SSH for ten minutes at a time, while a motion rule went on switching the
 * hall light on: the board was up and working, and its radio was asleep. That
 * failure is invisible from every surface the product has — the hub cannot
 * report that it is unreachable — so the only place it can be fixed is here.
 *
 * `deploy/` has no type checker behind it, so this runs the installer's own
 * function against a fake `ip`, `iw`, `nmcli` and `systemctl` and files the
 * test owns, the way `GETHOME_CMDLINE` lets the memory-cgroup test run the
 * real rewrite against a `cmdline.txt` of its own.
 */

const repoRoot = path.join(import.meta.dirname, '..');
const INSTALLER = path.join(repoRoot, 'deploy', 'install.sh');
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

interface Outcome {
  /** Every `iw` invocation, in order. */
  calls: string[];
  /** The dispatcher script as it was written, or '' when there is none. */
  dispatcher: string;
  /** Its octal mode — NM ignores one anybody but root can write. */
  dispatcherMode: string;
  /** The systemd unit, for a machine with no NetworkManager. */
  unit: string;
  /** What the installer said, `say` and `warn` together. */
  output: string;
}

function script(file: string, body: string): void {
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

/**
 * Run `keep_wifi_awake` out of install.sh.
 *
 * `route` is what `ip -o route show default` answers, `wireless` names the
 * interfaces that have a `wireless/` directory under the fake sysfs, and
 * `radioObeys: false` is the driver that reports success and changes nothing.
 */
function run(options: {
  route: string;
  wireless: string[];
  networkManager?: boolean;
  radioObeys?: boolean;
}): Outcome {
  const dir = mkdtempSync(path.join(tmpdir(), 'gethome-wifi-'));
  dirs.push(dir);
  const bin = path.join(dir, 'bin');
  const net = path.join(dir, 'net');
  const calls = path.join(dir, 'iw-calls');
  const state = path.join(dir, 'iw-state');
  const dispatcher = path.join(dir, 'dispatcher.d', '50-gethome-wifi-awake');
  const unit = path.join(dir, 'gethome-wifi-awake.service');
  mkdirSync(bin, { recursive: true });
  for (const iface of options.wireless) mkdirSync(path.join(net, iface, 'wireless'), { recursive: true });
  writeFileSync(state, 'Power save: on\n');

  script(path.join(bin, 'ip'), `printf '%s' "$FAKE_ROUTE"`);
  script(
    path.join(bin, 'iw'),
    `echo "$*" >> "${calls}"
     case "$3 $4" in
       "get power_save") cat "${state}" ;;
       "set power_save") [ "$FAKE_RADIO_OBEYS" = "no" ] || echo "Power save: $5" > "${state}" ;;
     esac`,
  );
  script(path.join(bin, 'systemctl'), 'exit 0');
  if (options.networkManager !== false) script(path.join(bin, 'nmcli'), 'exit 0');

  const output = execFileSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
       SUDO=""
       say()  { printf 'SAY %s\\n' "$*"; }
       warn() { printf 'WARN %s\\n' "$*"; }
       eval "$(sed -n '/^find_iw() {/,/^}/p' "$1")"
       eval "$(sed -n '/^keep_wifi_awake() {/,/^}/p' "$1")"
       keep_wifi_awake`,
      'bash',
      INSTALLER,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        FAKE_ROUTE: options.route,
        FAKE_RADIO_OBEYS: options.radioObeys === false ? 'no' : 'yes',
        GETHOME_NET_DIR: net,
        GETHOME_NM_DISPATCHER: dispatcher,
        GETHOME_WIFI_UNIT: unit,
      },
    },
  );

  return {
    calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : [],
    dispatcher: existsSync(dispatcher) ? readFileSync(dispatcher, 'utf8') : '',
    dispatcherMode: existsSync(dispatcher) ? (statSync(dispatcher).mode & 0o777).toString(8) : '',
    unit: existsSync(unit) ? readFileSync(unit, 'utf8') : '',
    output,
  };
}

const WIFI_ROUTE = 'default via 192.168.0.1 dev wlan0 proto dhcp src 192.168.0.200 metric 600\n';

describe('keeping the hub on the network', () => {
  /**
   * A hub on Ethernet has no radio to keep awake, and the rule is that it gets
   * no unit, no dispatcher and nothing said about it — a paragraph about Wi-Fi
   * in the install log of a wired hub is one more thing to rule out later.
   */
  it('leaves a wired hub alone', () => {
    const result = run({
      route: 'default via 192.168.0.1 dev eth0 proto dhcp src 192.168.0.200 metric 100\n',
      wireless: ['wlan0'],
    });
    expect(result.calls).toEqual([]);
    expect(result.dispatcher).toBe('');
    expect(result.unit).toBe('');
    expect(result.output).toBe('');
  });

  /** No default route to judge by is the same answer: guess nothing. */
  it('says nothing when there is no default route', () => {
    const result = run({ route: '', wireless: ['wlan0'] });
    expect(result.calls).toEqual([]);
    expect(result.output).toBe('');
  });

  it('turns power saving off on the interface that carries the LAN', () => {
    const result = run({ route: WIFI_ROUTE, wireless: ['wlan0'] });
    expect(result.calls).toContain('dev wlan0 set power_save off');
    expect(result.output).toContain('SAY Wi-Fi power saving is off on wlan0');
  });

  /**
   * The live write is only half of it: NetworkManager turns power save back on
   * as it associates, so a hub that is fixed until its next reconnect is a hub
   * that is not fixed.
   */
  it('installs a dispatcher NetworkManager will actually run', () => {
    const result = run({ route: WIFI_ROUTE, wireless: ['wlan0'] });
    expect(result.dispatcher).toContain('set power_save off');
    // NM ignores a dispatcher script that anyone but root can write.
    expect(result.dispatcherMode).toBe('755');
    expect(result.unit).toBe('');
    expect(result.output).toContain('(NetworkManager)');
  });

  /**
   * And the dispatcher itself, run the way NM runs it: interface first, action
   * second. Every other event it is handed must be a no-op — it is called for
   * `down`, `dhcp4-change` and every interface on the machine.
   */
  it('the dispatcher acts only on a wireless interface coming up', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gethome-wifi-run-'));
    dirs.push(dir);
    const result = run({ route: WIFI_ROUTE, wireless: ['wlan0'] });

    const calls = path.join(dir, 'calls');
    const bin = path.join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    script(path.join(bin, 'iw'), `echo "$*" >> "${calls}"`);
    // The dispatcher was written with the fake `iw`'s absolute path; point it
    // at this one so the calls it makes land here.
    const dispatcher = path.join(dir, 'dispatch');
    writeFileSync(dispatcher, result.dispatcher.replace(/^exec \S+ /m, `exec ${path.join(bin, 'iw')} `));
    chmodSync(dispatcher, 0o755);

    const invoke = (iface: string, action: string): void => {
      execFileSync('bash', [dispatcher, iface, action], { encoding: 'utf8' });
    };
    invoke('wlan0', 'down');
    invoke('eth0', 'up');
    invoke('wlan0', 'dhcp4-change');
    expect(existsSync(calls)).toBe(false);

    invoke('wlan0', 'up');
    expect(readFileSync(calls, 'utf8').trim()).toBe('dev wlan0 set power_save off');
  });

  /**
   * A machine with no NetworkManager — wpa_supplicant and dhcpcd — has no
   * dispatcher to put this in, so it gets a unit bound to the device instead.
   */
  it('falls back to a unit where there is no NetworkManager', () => {
    const result = run({ route: WIFI_ROUTE, wireless: ['wlan0'], networkManager: false });
    expect(result.dispatcher).toBe('');
    expect(result.unit).toContain('Type=oneshot');
    expect(result.unit).toContain('sys-subsystem-net-devices-wlan0.device');
    expect(result.unit).toContain('set power_save off');
    expect(result.output).toContain('(systemd)');
  });

  /**
   * **Ask the radio, never the write.** A driver with no support for the call
   * answers success and changes nothing, and an installer that reported the
   * write would tell an owner the one thing that stops them looking further.
   */
  it('does not claim a radio is awake when it is still dozing', () => {
    const result = run({ route: WIFI_ROUTE, wireless: ['wlan0'], radioObeys: false });
    expect(result.calls).toContain('dev wlan0 set power_save off');
    expect(result.output).toContain('WARN Wi-Fi power saving could not be turned off on wlan0');
    expect(result.output).not.toContain('SAY');
  });
});
