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

/**
 * Run `deploy/wifi-credentials.sh` against a fake `nmcli`.
 *
 * `freq` is the frequency the hub is associated on (absent: `nmcli` does not
 * say), `scan` the rows a fresh scan returns in `nmcli -t -f FREQ,SSID` form,
 * already escaped the way `nmcli -t` escapes them, and `existing` a `wifi.env`
 * an earlier association left behind.
 */
function credentials(options: {
  ssid?: string;
  psk?: string;
  active?: boolean;
  nmcli?: boolean;
  freq?: number;
  scan?: string[];
  scanFails?: boolean;
  existing?: string;
}): CredentialsOutcome & { scanned: boolean } {
  const dir = scratch('gethome-wificreds-');
  const bin = path.join(dir, 'bin');
  const conf = path.join(dir, 'gethome');
  const calls = path.join(dir, 'nmcli-calls');
  mkdirSync(bin, { recursive: true });
  mkdirSync(conf, { recursive: true });
  if (options.existing !== undefined) writeFileSync(path.join(conf, 'wifi.env'), options.existing);

  if (options.nmcli !== false) {
    script_(
      path.join(bin, 'nmcli'),
      `echo "$*" >> "${calls}"
       case "$*" in
         *"connection show --active"*) [ "$FAKE_ACTIVE" = "no" ] || printf 'abc-123:802-11-wireless\\n' ;;
         *"802-11-wireless.ssid"*)     printf '%s\\n' "$FAKE_SSID" ;;
         *"802-11-wireless-security.psk"*) printf '%s\\n' "$FAKE_PSK" ;;
         *"dev wifi list --rescan no"*) [ -n "$FAKE_FREQ" ] && printf 'no:2437 MHz\\nyes:%s MHz\\n' "$FAKE_FREQ" ;;
         *"dev wifi list --rescan yes"*) [ "$FAKE_SCAN_FAILS" = "yes" ] && exit 8; printf '%s' "$FAKE_SCAN" ;;
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
      FAKE_FREQ: options.freq === undefined ? '' : String(options.freq),
      FAKE_SCAN: (options.scan ?? []).map((row) => `${row}\n`).join(''),
      FAKE_SCAN_FAILS: options.scanFails === true ? 'yes' : 'no',
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
    scanned: existsSync(calls) && readFileSync(calls, 'utf8').includes('--rescan yes'),
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

/**
 * **A dual-band hub can be on a network no Wi-Fi accessory can see.** Almost
 * every Wi-Fi Matter accessory is 2.4 GHz only, and a Pi 3B+, 4 or 5 will sit
 * on 5 GHz. One name on both bands costs nothing; a separate 5 GHz name, with
 * the hub on it, used to hand every accessory a network it could not find — and
 * the app never asked for another, because the hub said it had one.
 */
describe('a network the accessory can actually join', () => {
  it('does not scan when the hub is already on 2.4 GHz', () => {
    const run = credentials({ freq: 2412 });
    expect(run.file).toContain("WIFI_SSID='Flat 3'");
    expect(run.scanned).toBe(false);
  });

  it('hands over a network the hub is on the 5 GHz side of, when it is on 2.4 GHz too', () => {
    const run = credentials({
      freq: 5180,
      scan: ['5180 MHz:Flat 3', '2412 MHz:Flat 3', '2437 MHz:Next door'],
    });
    expect(run.scanned).toBe(true);
    expect(run.file).toContain("WIFI_SSID='Flat 3'");
  });

  it('hands nothing over for a network only 5 GHz can see, and says why', () => {
    const run = credentials({
      ssid: 'Flat 3 5G',
      freq: 5180,
      scan: ['5180 MHz:Flat 3 5G', '2412 MHz:Flat 3'],
      // What an earlier association on the 2.4 GHz side, or an older hub,
      // left behind: it has to go, or the hub goes on saying it has one.
      existing: "WIFI_SSID='Flat 3 5G'\nWIFI_PSK='hunter2hunter2'\n",
    });
    expect(run.file).toBe('');
    expect(run.output).toMatch(/only its 5 GHz radio can see/);
    expect(run.output).toMatch(/app will ask/);
  });

  /** A scan that says nothing is not evidence of anything. */
  it('changes nothing when the scan fails or does not show the network', () => {
    expect(credentials({ freq: 5180, scanFails: true }).file).toContain("WIFI_SSID='Flat 3'");
    expect(credentials({ freq: 5180, scan: ['2437 MHz:Next door'] }).file).toContain("WIFI_SSID='Flat 3'");
    expect(credentials({ freq: 5180, scan: [] }).file).toContain("WIFI_SSID='Flat 3'");
  });

  /**
   * `nmcli -t` escapes `\` and `:` inside a value, so a name with either in it
   * has to be decoded before it is compared — or the hub cannot recognise its
   * own network in the scan and falls back to handing it over regardless.
   */
  it('recognises a name nmcli has escaped', () => {
    const escaped = 'Flat\\:3\\\\B';
    expect(
      credentials({ ssid: 'Flat:3\\B', freq: 5180, scan: [`5180 MHz:${escaped}`] }).file,
    ).toBe('');
    expect(
      credentials({ ssid: 'Flat:3\\B', freq: 5180, scan: [`5180 MHz:${escaped}`, `2462 MHz:${escaped}`] }).file,
    ).toContain('WIFI_SSID=');
  });
});

/**
 * Run `matter_ipv6` out of install.sh against a fake `/proc/sys/net/ipv6/conf`
 * and `/sys/class/net`. `interfaces` names the interfaces the fake knows,
 * `physical` the ones with a `device` link, as a real NIC has.
 */
function ipv6(options: {
  interfaces?: string[];
  physical?: string[];
  noIpv6?: boolean;
  noRouteInfo?: boolean;
  forwarding?: boolean;
  disabledOn?: string;
}): { output: string; conf: string; live: Record<string, string> } {
  const dir = scratch('gethome-ipv6-');
  const bin = path.join(dir, 'bin');
  const proc = path.join(dir, 'proc');
  const net = path.join(dir, 'net');
  const conf = path.join(dir, 'sysctl.d', '61-gethome-matter.conf');
  mkdirSync(bin, { recursive: true });
  mkdirSync(path.dirname(conf), { recursive: true });
  const interfaces = options.interfaces ?? ['lo', 'wlan0'];
  const physical = options.physical ?? ['wlan0'];
  if (options.noIpv6 !== true) {
    for (const name of ['all', 'default', ...interfaces]) {
      mkdirSync(path.join(proc, name), { recursive: true });
      if (options.noRouteInfo !== true) writeFileSync(path.join(proc, name, 'accept_ra_rt_info_max_plen'), '0');
      writeFileSync(path.join(proc, name, 'forwarding'), options.forwarding === true ? '1' : '0');
      writeFileSync(path.join(proc, name, 'disable_ipv6'), options.disabledOn === name ? '1' : '0');
    }
  }
  for (const name of interfaces) {
    mkdirSync(path.join(net, name), { recursive: true });
    if (physical.includes(name)) writeFileSync(path.join(net, name, 'device'), '');
  }
  script_(path.join(bin, 'ip'), `printf 'default via 192.168.0.1 dev wlan0 proto dhcp metric 600\\n'`);

  const output = execFileSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
       SUDO=""
       say()  { printf 'SAY %s\\n' "$*"; }
       warn() { printf 'WARN %s\\n' "$*"; }
       prog="/^matter_ipv6() {/,/^}/p"
       eval "$(sed -n "$prog" "$1")"
       matter_ipv6`,
      'bash',
      INSTALLER,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        GETHOME_SYSCTL_MATTER: conf,
        GETHOME_PROC_IPV6: proc,
        GETHOME_NET_DIR: net,
      },
    },
  );
  const live: Record<string, string> = {};
  for (const name of ['default', ...interfaces]) {
    const file = path.join(proc, name, 'accept_ra_rt_info_max_plen');
    if (existsSync(file)) live[name] = readFileSync(file, 'utf8').trim();
  }
  return { output, conf: existsSync(conf) ? readFileSync(conf, 'utf8') : '', live };
}

/**
 * **A Thread accessory is reached through a route its border router
 * announces**, as a Route Information Option in its router advertisements —
 * which Linux ignores by default (`accept_ra_rt_info_max_plen` is 0; matter.js
 * and OpenThread both put setting it to 64 first in their troubleshooting). A
 * Thread plug shared into GetHome from Apple Home would pair through the phone
 * and then never be heard from again.
 */
describe('reaching a Thread accessory through its border router', () => {
  it('takes routes up to /64, now and after every boot, on each physical interface', () => {
    const run = ipv6({ interfaces: ['lo', 'eth0', 'wlan0', 'docker0'], physical: ['eth0', 'wlan0'] });
    expect(run.conf).toContain('net.ipv6.conf.default.accept_ra_rt_info_max_plen = 64');
    expect(run.conf).toContain('net.ipv6.conf.eth0.accept_ra_rt_info_max_plen = 64');
    expect(run.conf).toContain('net.ipv6.conf.wlan0.accept_ra_rt_info_max_plen = 64');
    // A virtual interface is not a LAN a border router is on.
    expect(run.conf).not.toContain('docker0');
    expect(run.conf).not.toContain('.lo.');
    expect(run.live.wlan0).toBe('64');
    expect(run.live.default).toBe('64');
    expect(run.output).toContain('SAY');
    expect(run.output).not.toContain('WARN');
  });

  it('says so when this machine has no IPv6 at all', () => {
    const run = ipv6({ noIpv6: true });
    expect(run.output).toMatch(/WARN IPv6 is switched off/);
    expect(run.conf).toBe('');
  });

  it('says so when the kernel cannot learn routes from advertisements', () => {
    const run = ipv6({ noRouteInfo: true });
    expect(run.output).toMatch(/WARN This kernel cannot learn routes/);
    expect(run.conf).toBe('');
  });

  it('warns about forwarding, which quietly undoes it', () => {
    expect(ipv6({ forwarding: true }).output).toMatch(/WARN IPv6 forwarding is on/);
  });

  it('warns when the LAN interface has no IPv6, which Matter will not start without', () => {
    expect(ipv6({ disabledOn: 'wlan0' }).output).toMatch(/WARN IPv6 is disabled on wlan0/);
  });
});

/**
 * What the hub says about Bluetooth in the thirty seconds before it knows.
 *
 * The API listens **before** the adapters start — deliberately, so a slow
 * radio cannot hold port 8420 closed — which leaves a window on every boot
 * where `GET /hub` is answering for a Matter adapter that has not run a line
 * of its own code. Found on the hub itself: a poll taken during a restart
 * reported `bluetooth: false, bluetoothReason: "off"`, and `off` means
 * *nobody asked for it*. Specific, actionable and wrong — the app's advice for
 * it is to go and turn Bluetooth on.
 */
describe('before the Matter adapter has started', () => {
  it('says it has not decided yet, rather than saying Bluetooth is off', async () => {
    const { MatterAdapter } = await import('../src/adapters/matter/adapter.js');
    const adapter = new MatterAdapter({
      storagePath: '/nonexistent/never-opened',
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    } as unknown as ConstructorParameters<typeof MatterAdapter>[0]);
    // Constructed and never started, which is exactly the state the API
    // answers from for the first half-minute of every boot.
    expect(adapter.bleStatus).toEqual({ enabled: false, reason: 'starting' });
  });
});
