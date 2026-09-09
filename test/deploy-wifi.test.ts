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
  /** The fake sysfs this run was given, so a test can add an interface to it. */
  netDir: string;
}

function script_(file: string, body: string): void {
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

/**
 * Run `keep_wifi_awake` out of install.sh.
 *
 * `route` is what `ip -o route show default` answers, `wireless` names the
 * interfaces that are wireless under the fake sysfs, and `radioObeys: false`
 * is the driver that reports success and changes nothing.
 *
 * `marker` is which of the two sysfs entries those interfaces get. `wireless/`
 * is the wireless-extensions directory and is what most drivers have;
 * `phy80211` is cfg80211's own link to the radio and is what a driver built
 * without the extensions has instead. Both have to count, or the whole
 * section silently does nothing on the second kind of board — and says
 * nothing, because "not a wireless hub" is the case that is meant to be quiet.
 */
function run(options: {
  route: string;
  wireless: string[];
  marker?: 'wireless' | 'phy80211';
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
  for (const iface of options.wireless) {
    mkdirSync(path.join(net, iface), { recursive: true });
    if ((options.marker ?? 'wireless') === 'wireless') {
      mkdirSync(path.join(net, iface, 'wireless'), { recursive: true });
    } else {
      // A symlink into the ieee80211 tree, which is what sysfs has there.
      writeFileSync(path.join(net, iface, 'phy80211'), '');
    }
  }
  writeFileSync(state, 'Power save: on\n');

  script_(path.join(bin, 'ip'), `printf '%s' "$FAKE_ROUTE"`);
  script_(
    path.join(bin, 'iw'),
    `echo "$*" >> "${calls}"
     case "$3 $4" in
       "get power_save") cat "${state}" ;;
       "set power_save") [ "$FAKE_RADIO_OBEYS" = "no" ] || echo "Power save: $5" > "${state}" ;;
     esac`,
  );
  script_(path.join(bin, 'systemctl'), 'exit 0');
  if (options.networkManager !== false) script_(path.join(bin, 'nmcli'), 'exit 0');

  const output = execFileSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
       SUDO=""
       say()  { printf 'SAY %s\\n' "$*"; }
       warn() { printf 'WARN %s\\n' "$*"; }
       for fn in find_iw lan_wifi_iface wifi_frequency_mhz keep_wifi_awake; do
         # The sed program is built first, deliberately. Written inline, its
         # braces sit inside a second level of double quotes within a command
         # substitution — which bash 3.2, the bash macOS ships and the one this
         # suite is usually run under, brace-expands anyway: sed is handed
         # \`/^fn() /\` and \`/^/p\` as two arguments and every extraction fails.
         prog="/^$fn() {/,/^}/p"
         eval "$(sed -n "$prog" "$1")"
       done
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
    netDir: net,
  };
}

const WIFI_ROUTE = 'default via 192.168.0.1 dev wlan0 proto dhcp src 192.168.0.200 metric 600\n';

/**
 * Run `keep_wifi_reachable` out of install.sh against files the test owns.
 *
 * Returns the unit and the script it writes, or empty strings for the wired
 * hub that must get neither.
 */
function keepalive(options: { route: string; wireless: string[]; arping?: boolean }): {
  unit: string;
  script: string;
  scriptMode: string;
  output: string;
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'gethome-keepalive-'));
  dirs.push(dir);
  const bin = path.join(dir, 'bin');
  const net = path.join(dir, 'net');
  const unit = path.join(dir, 'gethome-wifi-keepalive.service');
  const script = path.join(dir, 'lib', 'gethome-wifi-keepalive.sh');
  mkdirSync(bin, { recursive: true });
  for (const iface of options.wireless) mkdirSync(path.join(net, iface, 'wireless'), { recursive: true });
  script_(path.join(bin, 'ip'), `printf '%s' "$FAKE_ROUTE"`);
  script_(path.join(bin, 'systemctl'), 'exit 0');
  // Stubbed rather than borrowed from the host: whether this machine happens
  // to have `arping` decides which branch runs, and a test that says something
  // different on a Mac and in CI is the trap this file already carries a note
  // about. `apt-get` too, so the install path is never reached for real.
  if (options.arping !== false) script_(path.join(bin, 'arping'), 'exit 0');
  script_(path.join(bin, 'apt-get'), 'exit 0');

  const output = execFileSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
       SUDO=""
       say()  { printf 'SAY %s\n' "$*"; }
       warn() { printf 'WARN %s\n' "$*"; }
       for fn in lan_wifi_iface keep_wifi_reachable; do
         prog="/^$fn() {/,/^}/p"
         eval "$(sed -n "$prog" "$1")"
       done
       keep_wifi_reachable`,
      'bash',
      INSTALLER,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        FAKE_ROUTE: options.route,
        GETHOME_NET_DIR: net,
        GETHOME_KEEPALIVE_UNIT: unit,
        GETHOME_KEEPALIVE_SCRIPT: script,
      },
    },
  );

  return {
    unit: existsSync(unit) ? readFileSync(unit, 'utf8') : '',
    script: existsSync(script) ? readFileSync(script, 'utf8') : '',
    scriptMode: existsSync(script) ? (statSync(script).mode & 0o777).toString(8) : '',
    output,
  };
}

/**
 * **The fault needs the path to be idle, and that is what named it.**
 *
 * A continuous one-per-second ping from a Mac on the same Wi-Fi held the hub
 * reachable for fourteen minutes without a single loss, twenty minutes after
 * the same hub had been unreachable for four minutes at a stretch. Traffic
 * prevented it; quiet caused it — which is the owner's whole experience, since
 * an app opened after a while is exactly a path that has been silent.
 *
 * What goes quiet is one *pair*: the Mac is on 5 GHz and the hub's radio on
 * 2.4 GHz, so their traffic crosses the bridge between the two radios inside
 * the router, and it is this hub's entry on that bridge which ages out. During
 * one of these the hub answered its own health check in 3 ms, exchanged pings
 * with the gateway throughout and served another client 37 KB in one 20-second
 * window, while three pings from the Mac got nothing at all.
 *
 * Measured with the path deliberately idled for 55 seconds between probes:
 * **252 probes over four hours, 503 of 504 replies, one lost packet**, against
 * a gateway control that lost none.
 */
describe('keeping the hub reachable after a quiet spell', () => {
  it('announces itself by broadcast, which is the only thing that crosses', () => {
    const result = keepalive({ route: WIFI_ROUTE, wireless: ['wlan0'] });
    // **A gratuitous ARP, not a unicast.** A ping at the router is addressed
    // to the router and never crosses the bridge it is meant to keep warm;
    // that was shipped first and did not work. `-U` is the broadcast form.
    expect(result.script).toMatch(/arping\s+-U\b/);
    expect(result.scriptMode).toBe('755');
    // Bounded and quiet: this is a broadcast, so every station on the network
    // pays for it, and one every few seconds would be rude.
    const interval = Number(/sleep (\d+)/.exec(result.script)![1]);
    expect(interval).toBeGreaterThanOrEqual(10);
    expect(interval).toBeLessThanOrEqual(60);
    // Re-read, never captured: a lease or an interface that moves must not
    // leave this announcing an address it no longer has.
    expect(result.script).toContain('ip route show default');
    expect(result.script).toContain('ip -4 -o addr show');
    expect(result.unit).toContain('Restart=always');
    expect(result.output).toContain('SAY');
  });

  /**
   * **A hub that cannot broadcast has to say so.** Without `arping` the loop
   * falls back to the gateway ping, which is exactly the thing that was
   * measured not to work — so the install must not go quiet about it.
   */
  it('says so when it cannot send the broadcast', () => {
    const result = keepalive({ route: WIFI_ROUTE, wireless: ['wlan0'], arping: false });
    expect(result.output).toContain('WARN');
    expect(result.output).toMatch(/arping/);
  });

  /** A wired hub has no access point to convince. */
  it('leaves a wired hub alone', () => {
    const result = keepalive({
      route: 'default via 192.168.0.1 dev eth0 proto dhcp metric 100\n',
      wireless: ['wlan0'],
    });
    expect(result.unit).toBe('');
    expect(result.script).toBe('');
    expect(result.output).toBe('');
  });
});

/** Run `zigbee_channel_clear_of_wifi` out of install.sh for one Wi-Fi centre. */
function zigbeeChannelFor(wifiMhz: string): number {
  return Number(
    execFileSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
         eval "$(sed -n '/^zigbee_channel_clear_of_wifi() {/,/^}/p' "$1")"
         zigbee_channel_clear_of_wifi "$2"`,
        'bash',
        INSTALLER,
        wifiMhz,
      ],
      { encoding: 'utf8' },
    ),
  );
}

/**
 * **Zigbee and Wi-Fi share the band, and Zigbee2MQTT's default sits in the
 * middle of the commonest Wi-Fi channel there is.** Channel 11 is 2405 MHz,
 * inside Wi-Fi channel 1 (2412 ± 11), with the coordinator on the Pi's USB
 * socket and the Wi-Fi antenna printed on the board next to it. Zigbee wins
 * that contention and Wi-Fi loses inbound, which reads as a hub that is up,
 * running its automations, and unreachable from every phone in the house.
 */
/**
 * Run `warn_if_zigbee_jams_wifi` with a fake `ip`/`iw` and a coordinator backup
 * the test owns. Returns whatever it said, which for most hubs is nothing.
 */
function collisionWarning(options: { wifiMhz: string; zigbeeChannel?: number }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gethome-zigbee-'));
  dirs.push(dir);
  const bin = path.join(dir, 'bin');
  const net = path.join(dir, 'net');
  mkdirSync(bin, { recursive: true });
  mkdirSync(path.join(net, 'wlan0', 'wireless'), { recursive: true });
  script_(path.join(bin, 'ip'), `printf '%s' "$FAKE_ROUTE"`);
  script_(path.join(bin, 'iw'), `[ "$3" = "link" ] && printf 'Connected\n\tfreq: %s.0\n' "$FAKE_FREQ"; exit 0`);
  if (options.zigbeeChannel !== undefined) {
    writeFileSync(
      path.join(dir, 'coordinator_backup.json'),
      JSON.stringify({ metadata: { version: 1 }, logical_channel: options.zigbeeChannel }),
    );
  }

  return execFileSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
       SUDO=""
       Z2M_DATA_DIR="$2"
       Z2M_CONFIG="$2/configuration.yaml"
       say()  { printf 'SAY %s\n' "$*"; }
       warn() { printf 'WARN %s\n' "$*"; }
       for fn in find_iw lan_wifi_iface wifi_frequency_mhz zigbee_channel_clear_of_wifi \
                 zigbee_network_channel warn_if_zigbee_jams_wifi; do
         prog="/^$fn() {/,/^}/p"
         eval "$(sed -n "$prog" "$1")"
       done
       warn_if_zigbee_jams_wifi`,
      'bash',
      INSTALLER,
      dir,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        FAKE_ROUTE: WIFI_ROUTE,
        FAKE_FREQ: options.wifiMhz,
        GETHOME_NET_DIR: net,
      },
    },
  );
}

/**
 * **A hub that already has a network keeps its channel — but is told.** This is
 * the half the choice above cannot reach: every hub installed before it, this
 * one included, formed on Zigbee 11 and may be sitting on its own uplink. The
 * symptom has no owner until somebody names it, because Zigbee is connected,
 * the devices report, and the casualty is the other radio entirely.
 */
describe('an existing Zigbee network on top of the hub Wi-Fi', () => {
  it('says so, and names the channel to move to and what moving costs', () => {
    // The case this was found on: Zigbee 11 (2405 MHz) inside Wi-Fi 1 (2412).
    const said = collisionWarning({ wifiMhz: '2412', zigbeeChannel: 11 });
    expect(said).toContain('WARN');
    expect(said).toContain('channel 11');
    expect(said).toContain('2405 MHz');
    expect(said).toMatch(/[Cc]hannel 25/);
    // Never silently: moving it re-forms the network.
    expect(said).toMatch(/paired again/);
    // And never as a diagnosis of an outage — it is a standing handicap whose
    // size depends on how busy the Zigbee side is. Saying more than that sends
    // somebody after the wrong radio for an evening.
    expect(said).not.toMatch(/unreachable|cannot be reached/i);
  });

  it('stays quiet when the two radios are already clear of each other', () => {
    expect(collisionWarning({ wifiMhz: '2412', zigbeeChannel: 25 })).toBe('');
    expect(collisionWarning({ wifiMhz: '2462', zigbeeChannel: 11 })).toBe('');
  });

  /** No network yet is the install that picks a channel, not one to warn about. */
  it('stays quiet when this hub has no network', () => {
    expect(collisionWarning({ wifiMhz: '2412' })).toBe('');
  });
});

describe('choosing a Zigbee channel', () => {
  it('stays clear of whichever Wi-Fi channel this hub is on', () => {
    // Wi-Fi 1 and 6 both push it to the top of the band; Wi-Fi 11 to the
    // bottom. The point is the distance, not the particular number.
    expect(zigbeeChannelFor('2412')).toBe(25);
    expect(zigbeeChannelFor('2437')).toBe(25);
    expect(zigbeeChannelFor('2462')).toBe(11);
    expect(zigbeeChannelFor('2472')).toBe(11);
  });

  it('never lands inside the Wi-Fi channel it was given', () => {
    for (const wifi of [2412, 2417, 2422, 2427, 2437, 2447, 2452, 2462, 2472]) {
      const zigbee = zigbeeChannelFor(String(wifi));
      const mhz = 2405 + 5 * (zigbee - 11);
      // A 20 MHz Wi-Fi channel is its centre ± 11 MHz.
      expect(Math.abs(mhz - wifi), `Zigbee ${zigbee} (${mhz} MHz) vs Wi-Fi ${wifi} MHz`)
        .toBeGreaterThan(11);
    }
  });

  /**
   * A wired hub, or a radio that would not say, is *no information* — never a
   * frequency. 25 is still the better guess than upstream's 11, which is
   * inside Wi-Fi channel 1.
   */
  it('guesses away from the common Wi-Fi channels when it cannot measure', () => {
    expect(zigbeeChannelFor('')).toBe(25);
  });

  /** 26 is capped or unsupported in enough places not to be worth choosing. */
  it('never picks channel 26', () => {
    for (let wifi = 2400; wifi <= 2490; wifi += 5) {
      expect(zigbeeChannelFor(String(wifi))).toBeLessThanOrEqual(25);
      expect(zigbeeChannelFor(String(wifi))).toBeGreaterThanOrEqual(11);
    }
  });

  /**
   * **And only when this hub has never formed a network.** Moving the channel
   * on a home that already has one is not an upgrade, it is every sleepy
   * device needing to be paired again.
   */
  it('leaves an existing network on the channel it formed on', () => {
    const installer = readFileSync(INSTALLER, 'utf8');
    expect(installer).toContain('coordinator_backup.json');
    const guarded = installer.slice(installer.indexOf('if [[ ! -f "$Z2M_CONFIG" ]]; then'));
    expect(guarded.slice(0, guarded.indexOf('elif'))).toContain('coordinator_backup.json');
  });
});

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
   * **A radio we fail to recognise is a fix that never runs and never says
   * so.** `wireless/` is the wireless-extensions directory, and a driver built
   * without them has only cfg80211's `phy80211` link — on which asking for the
   * first alone reads as "this hub is wired", which is the one answer that is
   * deliberately silent. The board would keep dozing with a clean install log.
   */
  it('recognises a radio that has only cfg80211s marker', () => {
    const result = run({ route: WIFI_ROUTE, wireless: ['wlan0'], marker: 'phy80211' });
    expect(result.calls).toContain('dev wlan0 set power_save off');
    expect(result.output).toContain('SAY Wi-Fi power saving is off on wlan0');
    // And the dispatcher has to ask the same question, or the fix lasts until
    // the next association.
    expect(result.dispatcher).toContain('phy80211');
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
    script_(path.join(bin, 'iw'), `echo "$*" >> "${calls}"`);
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

    // And a radio the extensions do not describe — cfg80211's `phy80211` and
    // no `wireless/` — is still a radio. NM hands the dispatcher every
    // interface on the machine, so this is the test that the question it asks
    // is the right one for both kinds.
    mkdirSync(path.join(result.netDir, 'wlan1'), { recursive: true });
    writeFileSync(path.join(result.netDir, 'wlan1', 'phy80211'), '');
    mkdirSync(path.join(result.netDir, 'eth1'), { recursive: true });
    invoke('eth1', 'up');
    invoke('wlan1', 'up');
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual([
      'dev wlan0 set power_save off',
      'dev wlan1 set power_save off',
    ]);
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
