import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MATTER_NEIGHBOURS_FILE } from '../src/adapters/matter/neighbours.js';

/**
 * The Wi-Fi decisions in `deploy/install.sh`: power save, and staying findable.
 *
 * Found on a Zero 2 W whose owner could not reach the hub from the app or over
 * SSH for ten minutes at a time, while a motion rule went on switching the
 * hall light on. Power save was blamed first and turned off, and the outages
 * went on: it was the router sitting on the broadcasts it owed the hub (see
 * "keeping the hub reachable after a quiet spell" below). Either way the
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

  // No NetworkManager is a PATH holding only the fakes, without `nmcli` — and
  // without the host's own, which any machine with NetworkManager installed
  // has beside every other tool in /usr/bin. Leaving the fake out is not
  // enough there: `command -v nmcli` finds the real one, and the function
  // installs a dispatcher. The PATH narrows after the lift, which needs `sed`,
  // keeping by name whichever of the host tools the function runs on either
  // branch the host has, and `cat` for the fake `iw` — so a branch taken
  // wrongly fails on what it wrote rather than on a missing command. One left
  // off the list fails the test rather than passing it, since each is on the
  // way to something it asserts.
  const host = path.join(dir, 'host');
  mkdirSync(host);
  const runPath = options.networkManager === false ? `${bin}:${host}` : `${bin}:${process.env.PATH ?? ''}`;

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
       for tool in awk tee grep dirname mkdir chown chmod cat; do
         if found="$(command -v "$tool")"; then ln -s "$found" "$HOST_TOOLS/$tool"; fi
       done
       PATH="$RUN_PATH"
       keep_wifi_awake`,
      'bash',
      INSTALLER,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        RUN_PATH: runPath,
        HOST_TOOLS: host,
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
function keepalive(options: {
  route: string;
  wireless: string[];
  arping?: boolean;
  kernelProbes?: boolean;
  /** Where the build being installed lives; a directory without the watchdog in it is an install that cannot place it. */
  hubDir?: string;
}): {
  unit: string;
  script: string;
  scriptMode: string;
  /** The watchdog as installed, and its mode, or '' when there is none. */
  watchdog: string;
  watchdogMode: string;
  /** Where it was installed. */
  watchdogPath: string;
  /** Every `systemctl` invocation, in order. */
  systemctl: string;
  output: string;
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'gethome-keepalive-'));
  dirs.push(dir);
  const bin = path.join(dir, 'bin');
  const net = path.join(dir, 'net');
  const unit = path.join(dir, 'gethome-wifi-keepalive.service');
  const script = path.join(dir, 'lib', 'gethome-wifi-keepalive.sh');
  const watchdog = path.join(dir, 'lib', 'gethome-wifi-watchdog.sh');
  mkdirSync(bin, { recursive: true });
  for (const iface of options.wireless) mkdirSync(path.join(net, iface, 'wireless'), { recursive: true });
  const systemctl = path.join(dir, 'systemctl-calls');
  // The install re-checks the gateway once, for real, so the fake has the
  // gateway's entry to show and a kernel that can refuse the re-check.
  script_(
    path.join(bin, 'ip'),
    `case "$*" in
       "-4 neigh show 192.168.0.1 dev wlan0") echo "192.168.0.1 lladdr 02:00:00:00:00:01 REACHABLE" ;;
       "neigh replace "*) [ "$FAKE_PROBE_REFUSED" = "yes" ] && exit 2; exit 0 ;;
       *) printf '%s' "$FAKE_ROUTE" ;;
     esac`,
  );
  script_(path.join(bin, 'systemctl'), `echo "$*" >> "${systemctl}"`);
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
       # The installer's own data directory, not a copy of it: the keep-alive
       # bakes in where the hub writes its Matter accessories, and the point
       # of asking is that the two agree.
       eval "$(grep -m1 '^DATA_DIR=' "$1")"
       for fn in lan_wifi_iface find_arping keep_wifi_reachable; do
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
        FAKE_PROBE_REFUSED: options.kernelProbes === false ? 'yes' : 'no',
        GETHOME_NET_DIR: net,
        GETHOME_KEEPALIVE_UNIT: unit,
        GETHOME_KEEPALIVE_SCRIPT: script,
        GETHOME_WIFI_WATCHDOG_BIN: watchdog,
        HUB_DIR: options.hubDir ?? repoRoot,
      },
    },
  );

  return {
    unit: existsSync(unit) ? readFileSync(unit, 'utf8') : '',
    script: existsSync(script) ? readFileSync(script, 'utf8') : '',
    scriptMode: existsSync(script) ? (statSync(script).mode & 0o777).toString(8) : '',
    watchdog: existsSync(watchdog) ? readFileSync(watchdog, 'utf8') : '',
    watchdogMode: existsSync(watchdog) ? (statSync(watchdog).mode & 0o777).toString(8) : '',
    watchdogPath: watchdog,
    systemctl: existsSync(systemctl) ? readFileSync(systemctl, 'utf8') : '',
    output,
  };
}

/**
 * **A router can sit on the broadcasts it owes the hub, and pass unicast
 * perfectly the whole time.**
 *
 * Measured behind a TP-Link Archer C6 (MediaTek radios): numbered broadcasts
 * from a Mac on 5 GHz reached the hub up to 43 seconds late, released in
 * bursts, and at worst three in five never arrived, while unicast from the same
 * Mac in the same minute arrived 45 of 45 inside 30 ms. Two things only ever
 * reach the hub that way, and each was its own outage.
 *
 * The first was the router losing its way to a hub that had been quiet. A
 * continuous ping held the hub reachable for fourteen minutes, twenty minutes
 * after it had been unreachable for four; with the hub announcing itself every
 * 20 seconds, **252 probes idled 55 seconds apart over four hours got 503 of
 * 504 replies**, against a gateway control that lost none.
 *
 * The second is what that measurement could not see, because 55 seconds never
 * lets a cache expire: **a phone asking for the hub again once its 20-minute ARP
 * entry has run out**, by broadcast, which the stuck queue swallows — so the
 * app reports `Host is down` about a hub that is up. A gratuitous ARP does not
 * help there, measured: macOS takes nothing from one, request or reply, and its
 * entry went back to 1200 seconds only when the hub asked for the Mac by name.
 */
describe('keeping the hub reachable after a quiet spell', () => {
  it('announces itself to the router by broadcast every round', () => {
    const result = keepalive({ route: WIFI_ROUTE, wireless: ['wlan0'] });
    // **A gratuitous ARP, not a unicast.** A ping at the router is addressed
    // to the router, and on its own it was shipped first and did not keep the
    // hub found. `-U` is the broadcast form.
    expect(result.script).toMatch(/"\$arping_bin" -U\b/);
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
    // **The binary is baked in by path, not looked up at run time.** Debian
    // has two different programs called `arping` with different interface
    // flags, and root's PATH finds `/usr/sbin` before `/usr/bin` — so a hub
    // with both installed would run the one whose flags we are not using, and
    // the announcement would stop without a word.
    expect(result.script).toMatch(/^arping_bin="\/[^"]*\/arping"$/m);
    expect(result.script).not.toMatch(/^\s*arping /m);
  });

  /**
   * **The gateway ping is gone, and should stay gone.** It was the first
   * attempt at the quiet-hub outage — shipped on the theory that the access
   * point thought the hub was asleep, disproved by the next commit — and was
   * kept afterwards because it "cost nothing". The gateway is one of the
   * neighbours the round re-checks now, so it bought nothing either.
   */
  it('does not ping the gateway', () => {
    const result = keepalive({ route: WIFI_ROUTE, wireless: ['wlan0'] });
    const code = result.script.split('\n').filter((line) => !/^\s*#/.test(line));
    expect(code.some((line) => /\bping\b/.test(line))).toBe(false);
  });

  /**
   * **The other half has to be able to happen, and the install has to say when
   * it cannot.** It tries one real re-check, of the gateway: a kernel or an
   * `ip` that refuses it would fail every call the loop makes, silently, which
   * leaves each phone's record of the hub to expire — the outage itself, behind
   * an install log with nothing in it.
   */
  it('says so when the kernel cannot be asked to re-check a neighbour', () => {
    const result = keepalive({ route: WIFI_ROUTE, wireless: ['wlan0'], kernelProbes: false });
    expect(result.output).toMatch(/WARN .*could not ask the kernel to re-check a neighbour/);
    // The broadcast half still installs: a hub with one of the two is better
    // off than a hub with neither.
    expect(result.script).not.toBe('');
  });

  it('stays quiet about it when the kernel takes the re-check', () => {
    const result = keepalive({ route: WIFI_ROUTE, wireless: ['wlan0'] });
    // Only this warning: whether the arping one fires depends on whether the
    // machine running the suite has a real `/usr/bin/arping` to fail with.
    expect(result.output).not.toMatch(/could not ask the kernel/);
  });

  /**
   * **Every update re-runs the installer, so the unit has to be restarted.**
   * `enable --now` does nothing to a unit that is already running, which would
   * leave a rewritten script on disk while the old one kept running until the
   * board next rebooted — a fix that ships and does not take effect, which is
   * the failure this branch has already paid for twice.
   */
  it('restarts the keep-alive rather than only enabling it', () => {
    const result = keepalive({ route: WIFI_ROUTE, wireless: ['wlan0'] });
    expect(result.systemctl).toMatch(/^restart gethome-wifi-keepalive$/m);
    expect(result.systemctl).not.toMatch(/enable --now/);
  });

  /**
   * **A hub that cannot broadcast has to say so.** Without `arping` nothing
   * tells the router the hub is still there, which is the first of the two
   * outages exactly — so the install must not go quiet about it.
   */
  it('says so when it cannot send the broadcast', () => {
    const result = keepalive({ route: WIFI_ROUTE, wireless: ['wlan0'], arping: false });
    expect(result.output).toContain('WARN');
    expect(result.output).toMatch(/could not announce itself/);
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

/**
 * Run one round of the keep-alive the installer wrote, for real, under `sh`.
 *
 * `neigh` is what the kernel's neighbour table says (`ip neigh show dev
 * wlan0`), `state` what the previous rounds remembered, and `matter` the list
 * the hub keeps of its Matter accessories. Returns every command the round
 * ran, in order, and what it remembered afterwards.
 */
function oneRound(options: { neigh: string; state?: string; matter?: string; route?: string }): {
  calls: string[];
  state: string;
} {
  const written = keepalive({ route: WIFI_ROUTE, wireless: ['wlan0'] });
  const dir = mkdtempSync(path.join(tmpdir(), 'gethome-round-'));
  dirs.push(dir);
  const bin = path.join(dir, 'bin');
  const calls = path.join(dir, 'calls');
  const state = path.join(dir, 'neighbours');
  // Always pointed somewhere the test owns, so a machine that happens to have
  // a real hub's data directory never lends this round its accessories.
  const matter = path.join(dir, MATTER_NEIGHBOURS_FILE);
  if (options.matter !== undefined) writeFileSync(matter, options.matter);
  mkdirSync(bin, { recursive: true });
  // A table the round can change, as the kernel's is: an entry it has seeded
  // reads back with the link address it was given, so a later loop in the same
  // round sees what the kernel would show it rather than the table it began from.
  const seeded = path.join(dir, 'seeded');
  script_(
    path.join(bin, 'ip'),
    `echo "ip $*" >> "${calls}"
     case "$*" in
       "route show default") printf '%s' "$FAKE_ROUTE" ;;
       "-4 -o addr show wlan0") echo "3: wlan0    inet 192.168.0.200/24 brd 192.168.0.255 scope global wlan0" ;;
       "neigh show dev wlan0") printf '%s' "$FAKE_NEIGH" ;;
       "neigh show "*" dev wlan0")
         hit=$(awk -v a="$3" '$1 == a' "${seeded}" 2>/dev/null | tail -n 1)
         if [ -n "$hit" ]; then echo "$hit"; else printf '%s' "$FAKE_NEIGH" | awk -v a="$3" '$1 == a'; fi ;;
       "neigh replace "*) echo "$3 lladdr $5 PROBE" >> "${seeded}" ;;
     esac`,
  );
  script_(path.join(bin, 'arping'), `echo "arping $*" >> "${calls}"`);
  script_(path.join(bin, 'ping'), `echo "ping $*" >> "${calls}"`);
  // The watchdog the round ends with has its own suite below; here it only
  // has to be called, so it is a fake that says it was.
  script_(path.join(bin, 'watchdog'), `echo "watchdog [$*]" >> "${calls}"`);
  if (options.state !== undefined) writeFileSync(state, options.state);
  // The installer bakes in whichever `arping` it resolved, which on a machine
  // that has one is the real thing. This round has to call the fake.
  const round = path.join(dir, 'keepalive.sh');
  writeFileSync(round, written.script.replace(/^arping_bin=.*$/m, `arping_bin="${path.join(bin, 'arping')}"`));
  execFileSync('sh', [round], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FAKE_ROUTE: options.route ?? WIFI_ROUTE,
      FAKE_NEIGH: options.neigh,
      GETHOME_KEEPALIVE_ONCE: '1',
      GETHOME_NEIGH_STATE: state,
      GETHOME_MATTER_NEIGHBOURS: matter,
      GETHOME_WIFI_WATCHDOG: path.join(bin, 'watchdog'),
    },
  });
  return {
    calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : [],
    state: existsSync(state) ? readFileSync(state, 'utf8') : '',
  };
}

/** The commands a round ran that changed anything, minus the reads and the watchdog's call. */
function writes(calls: string[]): string[] {
  return calls.filter((call) => !/^(ip (route show|-4 -o addr show|neigh show)|watchdog )/.test(call));
}

const now = (): number => Math.floor(Date.now() / 1000);

/**
 * **What keeps a phone's record of the hub alive is a question addressed to the
 * phone, and the kernel already knows how to ask one.** A stale neighbour put
 * into PROBE at the link address the kernel holds (`ip neigh replace … nud
 * probe`) gets an ARP request by unicast at once — measured on the hub: STALE
 * to REACHABLE inside a second, and the Mac's entry for the hub back at 1200
 * seconds from minus 345. Nothing in it is broadcast, so a router sitting on
 * its broadcasts never sees it. (`ip neigh change … use` asks the same more
 * politely, but only iproute2 5.17 and later know it.)
 */
describe("keeping every neighbour's record of the hub warm", () => {
  it('re-checks every stale neighbour by unicast, and nothing else', () => {
    const round = oneRound({
      neigh: [
        '192.168.0.1 lladdr 02:00:00:00:00:01 REACHABLE',
        '192.168.0.145 lladdr 02:00:00:00:01:45 STALE',
        '192.168.0.166 lladdr 02:00:00:00:01:66 STALE',
        '192.168.0.240 lladdr 02:00:00:00:02:40 DELAY',
        '192.168.0.9 FAILED',
        '192.168.0.10 INCOMPLETE',
        '',
      ].join('\n'),
    });
    expect(writes(round.calls)).toEqual([
      'arping -U -c 1 -I wlan0 192.168.0.200',
      'ip neigh replace 192.168.0.145 lladdr 02:00:00:00:01:45 nud probe dev wlan0',
      'ip neigh replace 192.168.0.166 lladdr 02:00:00:00:01:66 nud probe dev wlan0',
    ]);
  });

  /**
   * **Never by broadcast at a neighbour.** That is the path the router is
   * sitting on, and a broadcast wakes every sleeping device in the house. The
   * only `arping` is the hub announcing its own address.
   */
  it('broadcasts nothing but its own announcement', () => {
    const round = oneRound({
      neigh: '192.168.0.145 lladdr 02:00:00:00:01:45 STALE\n192.168.0.9 FAILED\n',
      state: `192.168.0.9 aa:bb:cc:dd:ee:09 ${now() - 600}\n`,
    });
    expect(round.calls.filter((call) => call.startsWith('arping'))).toEqual([
      'arping -U -c 1 -I wlan0 192.168.0.200',
    ]);
  });

  it('remembers who it has seen, and when each last answered', () => {
    const answered = now() - 300;
    const round = oneRound({
      neigh: '192.168.0.1 lladdr 02:00:00:00:00:01 REACHABLE\n192.168.0.145 lladdr 02:00:00:00:01:45 STALE\n',
      state: `192.168.0.145 02:00:00:00:01:45 ${answered}\n`,
    });
    const remembered = new Map(
      round.state
        .trim()
        .split('\n')
        .map((line) => line.split(' '))
        .map(([address, mac, seen]) => [address!, { mac: mac!, seen: Number(seen) }]),
    );
    // Reachable is an answer, so it is dated now.
    expect(remembered.get('192.168.0.1')!.mac).toBe('02:00:00:00:00:01');
    expect(Math.abs(remembered.get('192.168.0.1')!.seen - now())).toBeLessThan(60);
    // Stale is not: it keeps the time it last answered, or a neighbour that
    // never answers again would be remembered for ever.
    expect(remembered.get('192.168.0.145')).toEqual({ mac: '02:00:00:00:01:45', seen: answered });
  });

  /**
   * **A phone that comes home rejoins with an empty cache**, and the kernel has
   * long since given up on it. So the hub asks for it at the address and link
   * address it had — seeded straight into PROBE, which is a unicast question
   * (measured: a deleted entry REACHABLE again within two seconds) — and does
   * it on the round it starts with and every sixth after, which is two minutes
   * at 20 seconds a round.
   */
  it('asks about a neighbour the kernel has given up on, at the address it had', () => {
    const round = oneRound({
      neigh: '192.168.0.166 FAILED\n',
      state: `192.168.0.166 02:00:00:00:01:66 ${now() - 600}\n`,
    });
    expect(writes(round.calls)).toEqual([
      'arping -U -c 1 -I wlan0 192.168.0.200',
      'ip neigh replace 192.168.0.166 lladdr 02:00:00:00:01:66 nud probe dev wlan0',
    ]);
    expect(round.state).toContain('192.168.0.166 02:00:00:00:01:66');
    expect(keepalive({ route: WIFI_ROUTE, wireless: ['wlan0'] }).script).toContain('$((round % 6))');
  });

  it('and one the kernel has dropped altogether', () => {
    const round = oneRound({ neigh: '', state: `192.168.0.166 02:00:00:00:01:66 ${now() - 600}\n` });
    expect(writes(round.calls)).toEqual([
      'arping -U -c 1 -I wlan0 192.168.0.200',
      'ip neigh replace 192.168.0.166 lladdr 02:00:00:00:01:66 nud probe dev wlan0',
    ]);
  });

  /**
   * **Matter is IPv6, and its neighbour discovery is multicast through the same
   * queue.** So the same unicast re-check covers the IPv6 table: a Wi-Fi
   * accessory's record of the hub is refreshed by it, and a plug that comes
   * back from being switched off is found at its old link address. An IPv6
   * router keeps its flag, which a bare `replace` would clear.
   */
  it('re-checks IPv6 neighbours the same way, and keeps a router a router', () => {
    const round = oneRound({
      neigh: [
        'fe80::1 lladdr 02:00:00:00:00:01 router STALE',
        'fe80::5 lladdr 02:00:00:00:00:05 STALE',
        'fe80::6 lladdr 02:00:00:00:00:06 REACHABLE',
        '',
      ].join('\n'),
    });
    expect(writes(round.calls)).toEqual([
      'arping -U -c 1 -I wlan0 192.168.0.200',
      'ip neigh replace fe80::1 lladdr 02:00:00:00:00:01 router nud probe dev wlan0',
      'ip neigh replace fe80::5 lladdr 02:00:00:00:00:05 nud probe dev wlan0',
    ]);
  });

  it('finds a Matter plug that was switched off at the link address it had', () => {
    const round = oneRound({
      neigh: 'fe80::5 FAILED\n',
      state: `fe80::5 02:00:00:00:00:05 ${now() - 600}\n`,
    });
    expect(writes(round.calls)).toContain('ip neigh replace fe80::5 lladdr 02:00:00:00:00:05 nud probe dev wlan0');
  });

  /** Seeding an old address over a resolution in flight would only race it. */
  it('leaves alone a neighbour the kernel is already resolving', () => {
    const round = oneRound({
      neigh: '192.168.0.166 INCOMPLETE\n',
      state: `192.168.0.166 02:00:00:00:01:66 ${now() - 600}\n`,
    });
    expect(writes(round.calls).some((call) => call.includes('192.168.0.166'))).toBe(false);
    expect(round.state).toContain('192.168.0.166 02:00:00:00:01:66');
  });

  /** A day is long enough to cover coming home, and short enough not to keep asking after somebody who moved out. */
  it('forgets a neighbour that has not answered for a day', () => {
    const round = oneRound({ neigh: '', state: `192.168.0.77 aa:bb:cc:dd:ee:77 ${now() - 90_000}\n` });
    expect(writes(round.calls).some((call) => call.includes('192.168.0.77'))).toBe(false);
    expect(round.state).not.toContain('192.168.0.77');
  });

  /** It is our own file, but a keep-alive that dies on one bad line dies on every restart after it. */
  it('skips a line it cannot read rather than stopping', () => {
    const round = oneRound({
      neigh: '192.168.0.145 lladdr 02:00:00:00:01:45 STALE\n',
      state: `192.168.0.9 aa:bb:cc:dd:ee:09 yesterday\n192.168.0.166 02:00:00:00:01:66 ${now() - 600}\n`,
    });
    expect(writes(round.calls)).toContain('ip neigh replace 192.168.0.145 lladdr 02:00:00:00:01:45 nud probe dev wlan0');
    expect(writes(round.calls)).toContain('ip neigh replace 192.168.0.166 lladdr 02:00:00:00:01:66 nud probe dev wlan0');
    expect(round.state).not.toContain('192.168.0.9 ');
  });
});

/**
 * **A Matter accessory is found again by unicast however long it was gone.**
 *
 * Found on the hub the rest of this file came from: a plug switched off for
 * days came back at 09:58 by its own uptime and was reached at 10:07. The hub
 * retried at the right address every two minutes, and every retry died in
 * IPv6 neighbour discovery — multicast, which that router passed from the hub
 * to the plug 7 times in 30 while unicast went 30 in 30. The day this loop
 * remembers a neighbour for had long run out, and a reboot empties it for
 * every accessory at once. So the hub writes down each accessory it owns — the
 * link-local address and link address the accessory reports about itself —
 * and the round asks after every one the kernel has no link address for.
 */
describe('finding a Matter accessory that has been gone for longer than a day', () => {
  const MATTER = [
    '# Written by the GetHome hub: every Matter accessory it owns, at its link address.',
    'fe80::81b:2cff:fe3d:4e5f 0a:1b:2c:3d:4e:5f',
    '',
  ].join('\n');
  const PLUG_PROBE = 'ip neigh replace fe80::81b:2cff:fe3d:4e5f lladdr 0a:1b:2c:3d:4e:5f nud probe dev wlan0';

  it('asks for it by unicast at the address it reported, with no memory of it at all', () => {
    const round = oneRound({ neigh: 'fe80::81b:2cff:fe3d:4e5f FAILED\n', matter: MATTER });
    expect(writes(round.calls)).toEqual(['arping -U -c 1 -I wlan0 192.168.0.200', PLUG_PROBE]);
  });

  /** After a reboot the kernel has never heard of it, and neither has this loop. */
  it('and when the kernel has no entry for it either', () => {
    expect(writes(oneRound({ neigh: '', matter: MATTER }).calls)).toContain(PLUG_PROBE);
  });

  /** Two minutes, like the neighbours it remembers: often enough to matter, rarely enough to cost nothing. */
  it('asks on the same two-minute beat as everything else it remembers', () => {
    expect(keepalive({ route: WIFI_ROUTE, wireless: ['wlan0'] }).script).toMatch(
      /if \[ \$\(\(round % 6\)\) -eq 0 \] && \[ -f "\$matter" \]; then/,
    );
  });

  /** One the kernel holds a link address for is the stale re-check's, and asked about once. */
  it('leaves an accessory the kernel knows to the re-check that already covers it', () => {
    const reachable = oneRound({ neigh: 'fe80::81b:2cff:fe3d:4e5f lladdr 0a:1b:2c:3d:4e:5f REACHABLE\n', matter: MATTER });
    expect(writes(reachable.calls)).toEqual(['arping -U -c 1 -I wlan0 192.168.0.200']);
    const stale = oneRound({ neigh: 'fe80::81b:2cff:fe3d:4e5f lladdr 0a:1b:2c:3d:4e:5f STALE\n', matter: MATTER });
    expect(writes(stale.calls).filter((call) => call === PLUG_PROBE)).toHaveLength(1);
  });

  it('asks once about an accessory it also remembers', () => {
    const round = oneRound({
      neigh: 'fe80::81b:2cff:fe3d:4e5f FAILED\n',
      state: `fe80::81b:2cff:fe3d:4e5f 0a:1b:2c:3d:4e:5f ${now() - 600}\n`,
      matter: MATTER,
    });
    expect(writes(round.calls).filter((call) => call === PLUG_PROBE)).toHaveLength(1);
  });

  /**
   * **Over a resolution in flight too**, unlike a remembered neighbour: the
   * link address is the accessory's own word, and one the hub is busy trying
   * to reach is resolving nearly all the time — its traffic starts a new
   * multicast round the moment the last one fails — so waiting for a quiet
   * moment would be waiting for ever.
   */
  it('asks for it even while the kernel is resolving it', () => {
    const round = oneRound({ neigh: 'fe80::81b:2cff:fe3d:4e5f INCOMPLETE\n', matter: MATTER });
    expect(writes(round.calls)).toEqual(['arping -U -c 1 -I wlan0 192.168.0.200', PLUG_PROBE]);
  });

  /** The same accessory remembered for the day as well: the loop that remembers it waits, this one does not. */
  it('asks for one it also remembers while the kernel is resolving it', () => {
    const round = oneRound({
      neigh: 'fe80::81b:2cff:fe3d:4e5f INCOMPLETE\n',
      state: `fe80::81b:2cff:fe3d:4e5f 0a:1b:2c:3d:4e:5f ${now() - 60}\n`,
      matter: MATTER,
    });
    expect(writes(round.calls).filter((call) => call === PLUG_PROBE)).toHaveLength(1);
  });

  /**
   * **The file is the hub's and this runs as root**, so a line counts only if
   * it is exactly a link-local address and a MAC — never a keyword `ip` would
   * read as something else, never an IPv4 lease that may be somebody else's by
   * now, and never a word the shell could be talked into running.
   */
  it('takes nothing from the file but a link-local address and a MAC', () => {
    const round = oneRound({
      neigh: '',
      matter: [
        '# a comment',
        '192.168.0.218 0a:1b:2c:3d:4e:5f',
        '2001:db8::1 0a:1b:2c:3d:4e:5f',
        'fe80::81b:2cff:fe3d:4e5f%wlan0 0a:1b:2c:3d:4e:5f',
        'FE80::1 02:00:00:00:00:01',
        'fe80::2 02:00:00:00:00:2',
        'fe80::3 02:00:00:00:00:03:04',
        'fe80::4 02-00-00-00-00-04',
        'fe80::5;touch${IFS}/tmp/gethome-pwned 02:00:00:00:00:05',
        'fe80::6 $(touch /tmp/gethome-pwned)',
        'proxy fe80::7 02:00:00:00:00:07',
        `fe80:${':1'.repeat(20)} 02:00:00:00:00:08`,
        'fe80::9 02:00:00:00:00:09 and anything after',
        '',
      ].join('\n'),
    });
    expect(writes(round.calls)).toEqual([
      'arping -U -c 1 -I wlan0 192.168.0.200',
      'ip neigh replace fe80::9 lladdr 02:00:00:00:00:09 nud probe dev wlan0',
    ]);
    expect(existsSync('/tmp/gethome-pwned')).toBe(false);
  });

  it('reads no more of the file than a home could need', () => {
    const round = oneRound({ neigh: '', matter: `${'#'.repeat(20_000)}\nfe80::9 02:00:00:00:00:09\n` });
    expect(writes(round.calls)).toEqual(['arping -U -c 1 -I wlan0 192.168.0.200']);
  });

  it('goes on as before on a hub that has written no list', () => {
    const round = oneRound({ neigh: '192.168.0.145 lladdr 02:00:00:00:01:45 STALE\n' });
    expect(writes(round.calls)).toEqual([
      'arping -U -c 1 -I wlan0 192.168.0.200',
      'ip neigh replace 192.168.0.145 lladdr 02:00:00:00:01:45 nud probe dev wlan0',
    ]);
  });

  /**
   * **Two sides of one path.** The hub writes the list into its data directory
   * under `MATTER_NEIGHBOURS_FILE`, and the installer bakes the same path into
   * the keep-alive from its own `DATA_DIR` — which is also the `DATA_DIR` it
   * hands the hub in `hub.env`. Renaming either side alone would leave a
   * keep-alive reading nothing, and saying nothing about it.
   */
  it('reads the list where the hub writes it', () => {
    const dataDir = /^DATA_DIR="([^"]+)"$/m.exec(readFileSync(INSTALLER, 'utf8'))![1];
    expect(keepalive({ route: WIFI_ROUTE, wireless: ['wlan0'] }).script).toContain(
      `matter_neighbours="${dataDir}/${MATTER_NEIGHBOURS_FILE}"`,
    );
    expect(readFileSync(INSTALLER, 'utf8')).toMatch(/^DATA_DIR=\$\{DATA_DIR\}$/m);
  });
});

const WATCHDOG = path.join(repoRoot, 'deploy', 'wifi-watchdog.sh');
/** What `ip neigh show … nud reachable` prints when the gateway has answered. */
const ANSWER = '192.168.0.1 lladdr 02:00:00:00:00:01 REACHABLE';
/** The keep-alive's memory, as it writes it: address, link address, last reached. */
const MEMORY = ['192.168.0.1 02:00:00:00:00:01 1792009718', 'fe80::81b:2cff:fe3d:4e5f 0a:1b:2c:3d:4e:5f 1792009700', ''].join(
  '\n',
);

/**
 * A hub for `deploy/wifi-watchdog.sh` to look after, run for real.
 *
 * A fake sysfs with one radio — wlan0, driven by `driver`, brcmfmac unless
 * said otherwise — and the driver's bus counters in a fake debugfs; fakes for
 * everything the script asks or changes (`ip`, `nmcli`, `modprobe`, `iw`,
 * `tc`, `logger`, `systemctl`, `sleep`), and a clock the test moves. The PATH
 * holds those fakes and a handful of host tools by name and nothing else, so
 * no run can reach the machine's own `modprobe`, `systemctl` or `nmcli`, and
 * a hub with no NetworkManager is a fake left out rather than a host that
 * happens to have none.
 *
 * Each `run(at)` is one call at `at` seconds of uptime, the way the keep-alive
 * makes one at the end of each round. What the network does is a set of
 * switches: whether anything answers now, whether asking again brings an
 * answer, whether re-joining or reloading cures it, and whether a reloaded
 * driver brings the radio back at all.
 */
function watchdogHub(
  options: {
    driver?: string;
    nmcli?: boolean;
    memory?: string;
    /** A second Wi-Fi adapter beside the hub's own, driven by something else. */
    otherRadio?: boolean;
  } = {},
) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gethome-watchdog-'));
  dirs.push(dir);
  const bin = path.join(dir, 'bin');
  const net = path.join(dir, 'net');
  const calls = path.join(dir, 'calls');
  const log = path.join(dir, 'log');
  const reach = path.join(dir, 'reachable');
  const driver = options.driver ?? 'brcmfmac';
  mkdirSync(bin, { recursive: true });
  mkdirSync(path.join(dir, 'ieee80211', 'phy0'), { recursive: true });
  mkdirSync(path.join(dir, 'module', driver), { recursive: true });
  mkdirSync(path.join(dir, 'module', 'brcmfmac', 'holders', 'brcmfmac_cyw'), { recursive: true });
  mkdirSync(path.join(dir, 'debug', 'phy0'), { recursive: true });
  mkdirSync(path.join(dir, 'proc-ipv6', 'wlan0'), { recursive: true });
  writeFileSync(path.join(dir, 'proc-ipv6', 'wlan0', 'disable_ipv6'), '0\n');
  writeFileSync(
    path.join(dir, 'debug', 'phy0', 'counters'),
    'intrcount:    24124\nf2rxdata:     28794\nf2txdata:     14390\nfcqueued:     20035\nfc_xoff:      1\nfc_xon:       1\n',
  );
  // The radio as sysfs shows it, made by a shell snippet so the fake
  // `modprobe` can take it away and put it back the way a reload does — under
  // `$name`, which a reload may change (the `radio-name` flag's contents).
  const radio = [
    `mkdir -p "${net}/$name/wireless" "${net}/$name/statistics" "${net}/$name/device/driver"`,
    `ln -s "${dir}/ieee80211/phy0" "${net}/$name/phy80211"`,
    `ln -s "${dir}/module/${driver}" "${net}/$name/device/driver/module"`,
    `for c in rx_packets:36063 tx_packets:20050 rx_dropped:38 tx_dropped:0 tx_errors:0; do echo "\${c#*:}" > "${net}/$name/statistics/\${c%%:*}"; done`,
  ].join('\n');
  execFileSync('/bin/sh', ['-c', `name=wlan0\n${radio}`]);
  if (options.otherRadio) {
    mkdirSync(path.join(dir, 'module', 'iwlwifi'), { recursive: true });
    mkdirSync(path.join(net, 'wlan9', 'wireless'), { recursive: true });
    mkdirSync(path.join(net, 'wlan9', 'device', 'driver'), { recursive: true });
    execFileSync('/bin/ln', ['-s', path.join(dir, 'module', 'iwlwifi'), path.join(net, 'wlan9', 'device', 'driver', 'module')]);
  }
  // And an Ethernet interface beside it, which is never the watchdog's.
  mkdirSync(path.join(net, 'eth0', 'statistics'), { recursive: true });
  writeFileSync(path.join(dir, 'nm-state'), '100 (connected)\n');
  writeFileSync(path.join(dir, 'neighbours'), options.memory ?? MEMORY);

  script_(
    path.join(bin, 'ip'),
    `case "$*" in
       "neigh show dev "*" nud reachable") [ -f "${reach}" ] && cat "${reach}"; exit 0 ;;
       "neigh show dev "*) printf '192.168.0.1  FAILED\\nfe80::1  FAILED\\n192.168.0.218 lladdr 0a:1b:2c:3d:4e:5f STALE\\n' ;;
       "neigh replace "*) echo "ip $*" >> "${calls}"; [ -f "${dir}/answers-when-asked" ] && echo "${ANSWER}" > "${reach}"; exit 0 ;;
       *) echo "unexpected ip $*" >> "${calls}" ;;
     esac`,
  );
  if (options.nmcli !== false) {
    // The state is only ever asked for in the C locale: in any other, this
    // NetworkManager answers in German, as a real one would. Nothing else is
    // ever asked of it, and anything else is a call the suite will see.
    script_(
      path.join(bin, 'nmcli'),
      `case "$*" in
         "-g GENERAL.STATE device show wlan0")
           if [ "\${LC_ALL:-}" = C ]; then cat "${dir}/nm-state"; else echo "100 (verbunden)"; fi ;;
         *) echo "unexpected nmcli $*" >> "${calls}"; exit 1 ;;
       esac`,
    );
  }
  script_(
    path.join(bin, 'modprobe'),
    `echo "modprobe $*" >> "${calls}"
     if [ "$1" = -r ]; then
       for d in "${net}"/*; do case "$(readlink "$d/device/driver/module" 2>/dev/null)" in */brcmfmac) rm -rf "$d" ;; esac; done
       exit 0
     fi
     name=$(cat "${dir}/radio-name" 2>/dev/null || echo wlan0)
     n=$(cat "${dir}/loads" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${dir}/loads"
     [ -f "${dir}/radio-never-returns" ] && exit 1
     if [ -f "${dir}/radio-returns-second-time" ] && [ "$n" -lt 2 ]; then exit 0; fi
     ${radio.split('\n').join('\n     ')}
     [ -f "${dir}/reload-cures" ] && echo "${ANSWER}" > "${reach}"
     exit 0`,
  );
  script_(path.join(bin, 'systemctl'), `echo "systemctl $*" >> "${calls}"; [ "$1" = reboot ] && [ -f "${dir}/reboot-refused" ] && exit 1; exit 0`);
  script_(
    path.join(bin, 'logger'),
    `if [ "$1 $2 $3" = "-t gethome-wifi-watchdog --" ]; then shift 3; printf '%s\\n' "$*" >> "${log}"
     else echo "logger with the wrong tag: $*" >> "${log}"; fi`,
  );
  script_(
    path.join(bin, 'iw'),
    `case "$*" in "dev "*" station dump") ;; *) exit 1 ;; esac
     printf 'Station 02:00:00:00:00:01 (on wlan0)\\n\\tinactive time:\\t48020 ms\\n\\trx bytes:\\t932185\\n\\trx packets:\\t4662\\n\\ttx bytes:\\t979691\\n\\ttx packets:\\t2785\\n\\ttx retries:\\t12\\n\\ttx failed:\\t0\\n\\tsignal:  \\t-59 dBm\\n\\tconnected time:\\t878 seconds\\n'`,
  );
  script_(
    path.join(bin, 'tc'),
    `printf 'qdisc fq_codel 0: root refcnt 2 limit 10240p flows 1024\\n Sent 2690647 bytes 20053 pkt (dropped 0, overlimits 0 requeues 0)\\n backlog 0b 0p requeues 0\\n'`,
  );
  script_(path.join(bin, 'sleep'), 'exit 0');
  const host = path.join(dir, 'host');
  mkdirSync(host);
  const which = (tool: string): string => execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
  for (const tool of ['cat', 'head', 'awk', 'readlink', 'mv', 'rm', 'mkdir', 'ln']) {
    execFileSync('/bin/ln', ['-s', which(tool), path.join(host, tool)]);
  }
  // By path, because the PATH the script runs with has no shell on it.
  const bash = which('bash');

  const flag = (name: string, on = true): void => {
    if (on) writeFileSync(path.join(dir, name), '');
    else rmSync(path.join(dir, name), { force: true });
  };
  const read = (file: string): string[] =>
    existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];

  return {
    /** Whether a neighbour is REACHABLE right now. */
    answering(yes: boolean): void {
      if (yes) writeFileSync(reach, `${ANSWER}\n`);
      else rmSync(reach, { force: true });
    },
    /** What NetworkManager says the device's state is. */
    nm(state: string): void {
      writeFileSync(path.join(dir, 'nm-state'), `${state}\n`);
    },
    /** What the watchdog remembers from earlier calls, written as it would be. */
    remember(text: string): void {
      writeFileSync(path.join(dir, 'state'), text);
    },
    flag,
    /** One call, at `at` seconds since boot; `iface` null is a round with no default route. */
    run(at: number, iface: string | null = 'wlan0'): void {
      writeFileSync(path.join(dir, 'uptime'), `${at}.42 ${at * 3}.17\n`);
      execFileSync(bash, iface === null ? [WATCHDOG] : [WATCHDOG, iface], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${host}`,
          LANG: 'de_DE.UTF-8',
          GETHOME_NET_DIR: net,
          GETHOME_WATCHDOG_STATE: path.join(dir, 'state'),
          GETHOME_NEIGH_STATE: path.join(dir, 'neighbours'),
          GETHOME_UPTIME: path.join(dir, 'uptime'),
          GETHOME_SYS_MODULE: path.join(dir, 'module'),
          GETHOME_DEBUGFS: path.join(dir, 'debug'),
          GETHOME_PROC_IPV6: path.join(dir, 'proc-ipv6'),
          GETHOME_WATCHDOG_ASK_WAIT: '0',
          GETHOME_WATCHDOG_RADIO_WAIT: '3',
        },
      });
    },
    /** Every call from `from` to `to` seconds, `every` apart: the keep-alive's rounds. */
    rounds(from: number, to: number, every = 20, iface: string | null = 'wlan0'): void {
      for (let at = from; at <= to; at += every) this.run(at, iface);
    },
    /** Everything it changed or asked to change, in order. */
    calls: (): string[] => read(calls),
    /** What it wrote to the journal. */
    log: (): string[] => read(log),
    state: (): string => (existsSync(path.join(dir, 'state')) ? readFileSync(path.join(dir, 'state'), 'utf8') : ''),
    wlan0: (): boolean => existsSync(path.join(net, 'wlan0')),
    /** The name the next reload brings the radio back under. */
    reloadsAs(name: string): void {
      writeFileSync(path.join(dir, 'radio-name'), name);
    },
    /** An interface renamed after it appeared, the way a udev rule renames one. */
    rename(from: string, to: string): void {
      renameSync(path.join(net, from), path.join(net, to));
    },
  };
}

const RELOAD = ['modprobe -r brcmfmac_cyw brcmfmac', 'modprobe brcmfmac'];
const RESTART = 'systemctl reboot';
const HUB_RESTART = 'systemctl --no-block try-restart gethome-hubd.service';
const actions = (calls: string[]): string[] => calls.filter((call) => !call.startsWith('ip neigh replace'));

/**
 * **A hub that stays connected while nothing gets through restarts its radio,
 * then itself.**
 *
 * Found on the hub the rest of this file came from, on 2026-10-15: from 00:28
 * nothing passed over its Wi-Fi for fifty minutes — no ping, no SSH, no API,
 * no mDNS, one ping reply in all that time — while the machine ran perfectly,
 * NetworkManager said it was connected and nobody logged a word, until its
 * owner switched it off and on. The radio's firmware went on answering ARP for
 * it, which is how the Mac could tell the radio was alive. What broke is not
 * known, so the watchdog writes down what each side counted and then takes two
 * steps, cheapest first: it reloads the radio's driver, and five minutes later,
 * if nothing has answered, restarts the machine.
 *
 * Its trigger is the kernel's own word for an answer, a neighbour in
 * REACHABLE: on that hub, in almost three hours of a night sampled every 5 s,
 * there was never a gap longer than 10 s without one,
 * and a probe at a link address nobody has went to FAILED in three seconds —
 * the firmware answers ARP *for* the hub, never the hub's own questions.
 *
 * Most of these run at more than an hour of uptime, because a machine in its
 * first hour is never restarted; the test that says so starts earlier.
 */
describe('a hub whose Wi-Fi stays connected while nothing gets through', () => {
  /** The moments that matter: the two-minute line, the reload, the restart, and long after. */
  const MILESTONES = [5120, 5300, 5600, 9000];

  it('leaves a working network alone, and writes nothing about it', () => {
    const hub = watchdogHub();
    hub.answering(true);
    hub.rounds(5000, 5600);
    expect(hub.calls()).toEqual([]);
    expect(hub.log()).toEqual([]);
  });

  /**
   * **Only after an answer since the machine started.** A hub that boots onto
   * a network that never answers is not one whose Wi-Fi stopped, and the
   * memory of an answer is in /run, so a restart always starts here — which is
   * what keeps one from turning into a loop.
   */
  it('never acts on a hub that has not heard an answer since it started', () => {
    const hub = watchdogHub();
    hub.rounds(100, 9100, 600);
    hub.rounds(100, 9100, 600, null);
    expect(hub.calls()).toEqual([]);
    expect(hub.log()).toEqual([]);
  });

  /** Two minutes is long enough to be worth a line, and short of anything worth doing. */
  it('says so at two minutes, with what each side counted, once', () => {
    const hub = watchdogHub();
    hub.answering(true);
    hub.run(5000);
    hub.answering(false);
    hub.rounds(5020, 5280);
    expect(hub.calls()).toEqual([]);
    const said = hub.log();
    expect(said.filter((line) => line.startsWith('Nothing on the network has answered'))).toHaveLength(1);
    expect(said[0]).toMatch(/for 120 s, though NetworkManager says it is connected\. At 300 s it reloads the Wi-Fi driver\./);
    // Linux's own count, the radio's from its firmware, the driver's bus
    // counters, the transmit queue and the neighbour table: two of these a
    // few minutes apart are what says which side stopped.
    expect(said).toContain(
      '120 s in — Linux: rx_packets=36063 tx_packets=20050 rx_dropped=38 tx_dropped=0 tx_errors=0 disable_ipv6=0',
    );
    expect(said).toContain(
      '120 s in — radio: station=02:00:00:00:00:01 inactive_time=48020ms rx_packets=4662 tx_packets=2785 tx_retries=12 tx_failed=0 signal=-59dBm connected_time=878seconds',
    );
    expect(said).toContain('120 s in — bus: intrcount=24124 f2rxdata=28794 f2txdata=14390 fcqueued=20035 fc_xoff=1 fc_xon=1');
    expect(said.some((line) => /^120 s in — queue: Sent 2690647 bytes 20053 pkt \(dropped 0/.test(line))).toBe(true);
    expect(said.some((line) => /^120 s in — neighbours: .*FAILED=2/.test(line))).toBe(true);
  });

  /**
   * **The reload first**, and not a re-join: re-joining needs the very path
   * that has stopped — the 4-way handshake and DHCP both cross it — while a
   * reload restarts the firmware and joins the network afresh in one step.
   */
  it('reloads the driver at five minutes, asking everybody it remembers first', () => {
    const hub = watchdogHub();
    hub.answering(true);
    hub.run(5000);
    hub.answering(false);
    hub.rounds(5020, 5280);
    expect(actions(hub.calls())).toEqual([]);
    hub.run(5300);
    expect(hub.calls()).toEqual([
      // The keep-alive's own question, asked again now and by unicast, so the
      // decision rests on answers from the last few seconds.
      'ip neigh replace 192.168.0.1 lladdr 02:00:00:00:00:01 nud probe dev wlan0',
      'ip neigh replace fe80::81b:2cff:fe3d:4e5f lladdr 0a:1b:2c:3d:4e:5f nud probe dev wlan0',
      ...RELOAD,
    ]);
    expect(hub.wlan0()).toBe(true);
    expect(hub.log()).toContain(
      "Nothing on the network has answered this hub over wlan0 for 300 s, though NetworkManager says it is connected. Reloading the Wi-Fi driver (brcmfmac), which restarts the radio's firmware and joins the network afresh.",
    );
    expect(hub.log()).toContain('The Wi-Fi radio is back after reloading its driver.');
    expect(hub.log().some((line) => line.startsWith('Before reloading the driver — bus:'))).toBe(true);
  });

  /**
   * **Ask again before each step.** A keep-alive starved of CPU for minutes
   * sent no questions in that time, and its silence is not the network's.
   */
  it('does nothing when asking again brings an answer', () => {
    const hub = watchdogHub();
    hub.answering(true);
    hub.run(5000);
    hub.answering(false);
    hub.flag('answers-when-asked');
    hub.run(5400);
    expect(actions(hub.calls())).toEqual([]);
    expect(hub.log()).toContain(
      'The network answers this hub over wlan0 again, 400 s after it last did, when asked once more. Last step taken: none.',
    );
    // And the silence starts again from that answer, not from the old one.
    expect(hub.state()).toBe('5400 0 0 0 0 wlan0\n');
  });

  /**
   * **NetworkManager first.** When the link has really gone it is already
   * reconnecting — which is also why a router switched off or restarting
   * never sets this off: its access point goes, the link times out in 15 s,
   * and NetworkManager says so.
   */
  it('leaves the link to NetworkManager while it is not connected', () => {
    for (const state of ['30 (disconnected)', '70 (connecting (getting IP configuration))', '120 (failed)']) {
      const hub = watchdogHub();
      hub.answering(true);
      hub.run(5000);
      hub.answering(false);
      hub.nm(state);
      for (const at of MILESTONES) hub.run(at);
      expect(hub.calls(), state).toEqual([]);
      expect(hub.log(), state).toEqual([]);
    }
  });

  /** A device NetworkManager does not manage is somebody else's to fix. */
  it('never acts on a device NetworkManager says it does not manage', () => {
    const hub = watchdogHub();
    hub.answering(true);
    hub.run(5000);
    hub.answering(false);
    hub.nm('100 (connected (externally))');
    for (const at of MILESTONES) hub.run(at);
    expect(hub.calls()).toEqual([]);
  });

  /** Nothing without NetworkManager's word — the matter-ipv6 rule. */
  it('does nothing on a hub without NetworkManager', () => {
    const hub = watchdogHub({ nmcli: false });
    hub.answering(true);
    hub.run(5000);
    hub.answering(false);
    for (const at of MILESTONES) hub.run(at);
    expect(hub.calls()).toEqual([]);
    expect(hub.log()).toEqual([]);
  });

  /**
   * **After the reload, NetworkManager's word no longer decides.** An
   * activation over the path that stopped cannot finish — measured on the hub
   * with its own traffic dropped: NetworkManager associated, timed out in DHCP
   * and cycled between connecting and disconnected — so the hub has no default
   * route; the keep-alive calls with no interface, and the restart comes all
   * the same.
   */
  it('restarts the machine five minutes after the reload, whatever NetworkManager says by then', () => {
    const hub = watchdogHub();
    hub.answering(true);
    hub.run(5000);
    hub.answering(false);
    hub.run(5300);
    hub.nm('70 (connecting (getting IP configuration))');
    hub.rounds(5320, 5580, 20, null);
    expect(actions(hub.calls())).toEqual(RELOAD);
    hub.run(5600, null);
    expect(actions(hub.calls())).toEqual([...RELOAD, RESTART]);
    // Asked again first, on the interface the reload was about.
    expect(hub.calls().filter((call) => call.startsWith('ip neigh replace')).at(-1)).toMatch(/ dev wlan0$/);
    expect(hub.log()).toContain(
      'Nothing on the network has answered this hub over wlan0 for 600 s, 300 s of them since the driver was reloaded. Restarting this machine, the nearest it can come to the power cycle that brought the hub back the one time this was seen.',
    );
    expect(hub.log().some((line) => line.startsWith('Before restarting — Linux:'))).toBe(true);
  });

  it('and with a default route back, connected and still answered by nobody', () => {
    const hub = watchdogHub();
    hub.answering(true);
    hub.run(5000);
    hub.answering(false);
    hub.rounds(5020, 5580);
    expect(actions(hub.calls())).toEqual(RELOAD);
    hub.run(5600);
    expect(actions(hub.calls())).toEqual([...RELOAD, RESTART]);
  });

  /**
   * **Never in its first hour**, which is what keeps restarts to one an hour
   * whatever happens after: each starts the clock again.
   */
  it('never restarts a machine in its first hour', () => {
    const hub = watchdogHub();
    hub.answering(true);
    hub.run(1000);
    hub.answering(false);
    hub.run(1300);
    expect(actions(hub.calls())).toEqual(RELOAD);
    for (const at of [1600, 2000, 3000, 3580]) hub.run(at, null);
    expect(actions(hub.calls())).toEqual(RELOAD);
    const waiting = hub.log().filter((line) => line.includes('is not restarted in its first hour'));
    expect(waiting).toEqual([
      'Nothing on the network has answered this hub over wlan0 for 600 s. This machine has been up for 1600 s and is not restarted in its first hour; it will be at 3600 s if nothing has answered by then.',
    ]);
    hub.run(3600, null);
    expect(actions(hub.calls())).toEqual([...RELOAD, RESTART]);
  });

  /** A restart it was refused is asked for again five minutes later, never every round. */
  it('asks again five minutes after a restart is refused', () => {
    const hub = watchdogHub();
    hub.flag('reboot-refused');
    hub.answering(true);
    hub.run(5000);
    hub.answering(false);
    hub.rounds(5020, 5300);
    hub.rounds(5320, 5880, 20, null);
    expect(actions(hub.calls())).toEqual([...RELOAD, RESTART]);
    expect(hub.log()).toContain('The restart was refused; asking again in five minutes.');
    hub.run(5900, null);
    expect(actions(hub.calls())).toEqual([...RELOAD, RESTART, RESTART]);
    expect(hub.log()).toContain(
      'Nothing on the network has answered this hub over wlan0 for 900 s, and a restart asked for 300 s ago has not happened. Restarting this machine, the nearest it can come to the power cycle that brought the hub back the one time this was seen.',
    );
  });

  /** brcmfmac is the one driver this was tried on; any other radio goes straight to the restart. */
  it('restarts a machine whose radio has another driver at five minutes, reloading nothing', () => {
    const hub = watchdogHub({ driver: 'iwlwifi' });
    hub.answering(true);
    hub.run(5000);
    hub.answering(false);
    hub.rounds(5020, 5300);
    expect(actions(hub.calls())).toEqual([RESTART]);
    // And the two-minute line said so, rather than promising a reload.
    expect(hub.log().some((line) => /for 120 s, .*At 300 s it restarts this machine\.$/.test(line))).toBe(true);
    expect(hub.log()).toContain(
      'Nothing on the network has answered this hub over wlan0 for 300 s — its driver is iwlwifi, and reloading one has only been tried with brcmfmac. Restarting this machine, the nearest it can come to the power cycle that brought the hub back the one time this was seen.',
    );
  });

  /**
   * **The line that says which step worked.** Whether the reload cures the
   * fault that was seen is unmeasured — it has happened once — and this is
   * what will say, the next time.
   *
   * **And the hub restarts after a reload.** matter.js joins its mDNS groups
   * once, when it starts — measured on the hub: after a reload only avahi was
   * in the groups on the new wlan0, and a restart of the hub put matter.js
   * back — so the answer coming back after a silence that took a reload
   * restarts the hub, once and without waiting on it.
   */
  it('says when the network answers again after the reload, and restarts the hub once', () => {
    const hub = watchdogHub();
    hub.answering(true);
    hub.run(5000);
    hub.answering(false);
    hub.flag('reload-cures');
    hub.rounds(5020, 5320);
    expect(hub.log()).toContain(
      'The network answers this hub over wlan0 again, 320 s after it last did. Last step taken: reloading the Wi-Fi driver, 20 s before.',
    );
    expect(hub.log().some((line) => line.startsWith('Back — Linux:'))).toBe(true);
    expect(actions(hub.calls())).toEqual([...RELOAD, HUB_RESTART]);
    expect(hub.log().some((line) => line.startsWith('Restarting the hub (gethome-hubd): Matter joined its mDNS groups'))).toBe(
      true,
    );
    // And it is over: a working network is left alone again.
    hub.rounds(5340, 6000, 60);
    expect(actions(hub.calls())).toEqual([...RELOAD, HUB_RESTART]);
    expect(hub.state()).toBe('6000 0 0 0 0 wlan0\n');
  });

  /** The interface was replaced, however the answer came: asked once more is an answer too. */
  it('restarts the hub when asking again before the restart brings the answer', () => {
    const hub = watchdogHub();
    hub.answering(true);
    hub.run(5000);
    hub.answering(false);
    hub.run(5300);
    hub.flag('answers-when-asked');
    hub.run(5600, null);
    expect(actions(hub.calls())).toEqual([...RELOAD, HUB_RESTART]);
    expect(hub.log()).toContain(
      'The network answers this hub over wlan0 again, 600 s after it last did, when asked once more. Last step taken: reloading the Wi-Fi driver, 300 s before.',
    );
  });

  /** Without a reload in the silence the hub's own sockets are where they were, and it is left running. */
  it('leaves the hub running when the network answers before any step', () => {
    const hub = watchdogHub();
    hub.answering(true);
    hub.run(5000);
    hub.answering(false);
    hub.rounds(5020, 5200);
    hub.answering(true);
    hub.run(5220);
    expect(hub.log()).toContain('The network answers this hub over wlan0 again, 220 s after it last did. Last step taken: none.');
    expect(hub.calls()).toEqual([]);
  });

  /**
   * **A driver that does not bring its radio back is a restart at once**, in
   * the first hour or not: this step took the radio away, and a hub with no
   * Wi-Fi at all is one nobody can reach to give it back.
   */
  it('restarts the machine at once when the reloaded driver brings no radio back', () => {
    const hub = watchdogHub();
    hub.answering(true);
    hub.run(1000);
    hub.answering(false);
    hub.flag('radio-never-returns');
    hub.run(1300);
    expect(actions(hub.calls())).toEqual([...RELOAD, 'modprobe brcmfmac', RESTART]);
    expect(hub.log()).toContain(
      'The Wi-Fi radio did not come back after its driver was reloaded. Restarting this machine, which is the only thing known to bring it back.',
    );
  });

  it('and not when loading it a second time brings the radio back', () => {
    const hub = watchdogHub();
    hub.answering(true);
    hub.run(5000);
    hub.answering(false);
    hub.flag('radio-returns-second-time');
    hub.run(5300);
    expect(actions(hub.calls())).toEqual([...RELOAD, 'modprobe brcmfmac']);
    expect(hub.log()).toContain('The Wi-Fi radio is back after loading its driver a second time.');
  });

  /**
   * **The silence follows the radio, not its name.** On the hub this was
   * written on a reload brought wlan0 back as wlan0 three times out of three,
   * but the kernel takes the next free name and udev may rename it — and a
   * memory kept under the old name would follow up on an interface that no
   * longer exists, or forget the silence when a default route comes back on
   * the new one.
   */
  it('follows the radio when the reload brings it back under another name', () => {
    const hub = watchdogHub();
    hub.reloadsAs('wlan1');
    hub.answering(true);
    hub.run(5000);
    hub.answering(false);
    hub.run(5300);
    expect(hub.log()).toContain(
      'The Wi-Fi radio is back after reloading its driver, as wlan1 rather than wlan0; following it there.',
    );
    expect(hub.state()).toMatch(/ wlan1\n$/);
    hub.rounds(5320, 5600, 20, null);
    expect(actions(hub.calls())).toEqual([...RELOAD, RESTART]);
    expect(hub.calls().filter((call) => call.startsWith('ip neigh replace')).at(-1)).toMatch(/ dev wlan1$/);
  });

  it('and restarts the hub when the network answers again on the new name', () => {
    const hub = watchdogHub();
    hub.reloadsAs('wlan1');
    hub.answering(true);
    hub.run(5000);
    hub.answering(false);
    hub.run(5300);
    hub.answering(true);
    hub.run(5320, 'wlan1');
    expect(actions(hub.calls())).toEqual([...RELOAD, HUB_RESTART]);
    expect(hub.log()).toContain(
      'The network answers this hub over wlan1 again, 320 s after it last did. Last step taken: reloading the Wi-Fi driver, 20 s before.',
    );
  });

  /** Renamed after the reload had already found it: the memory still follows. */
  it('follows a radio renamed after the reload, with or without a default route', () => {
    for (const route of [null, 'wlan1'] as const) {
      const hub = watchdogHub();
      hub.answering(true);
      hub.run(5000);
      hub.answering(false);
      hub.run(5300);
      hub.rename('wlan0', 'wlan1');
      hub.rounds(5320, 5600, 20, route);
      expect(actions(hub.calls()), String(route)).toEqual([...RELOAD, RESTART]);
    }
  });

  /** A second Wi-Fi adapter is not the radio coming back: only one brcmfmac drives counts. */
  it('does not take another radio in the machine for the one it reloaded', () => {
    const hub = watchdogHub({ otherRadio: true });
    hub.answering(true);
    hub.run(1000);
    hub.answering(false);
    hub.flag('radio-never-returns');
    hub.run(1300);
    expect(actions(hub.calls())).toEqual([...RELOAD, 'modprobe brcmfmac', RESTART]);
  });

  /** A hub moved to a cable keeps its keep-alive, and has no radio for this to restart. */
  it('is only ever about a Wi-Fi interface', () => {
    const hub = watchdogHub();
    hub.answering(true);
    hub.run(5000, 'eth0');
    hub.answering(false);
    for (const at of MILESTONES) hub.run(at, 'eth0');
    expect(hub.calls()).toEqual([]);
    expect(hub.state()).toBe('');
  });

  /** A round with no default route is NetworkManager's business, unless this took a step it has to follow up. */
  it('with no default route, only follows up a reload of its own', () => {
    const hub = watchdogHub();
    hub.answering(true);
    hub.run(5000);
    hub.answering(false);
    for (const at of MILESTONES) hub.run(at, null);
    expect(hub.calls()).toEqual([]);
    expect(hub.log()).toEqual([]);
  });

  /**
   * What it remembers is about one interface, and anything it cannot read —
   * or that claims an answer later than now — is no memory at all.
   */
  it('treats a memory it cannot read, or one about another interface, as none', () => {
    for (const memory of [
      'garbage\n',
      '5000 0 0 0 0 wlan1\n',
      '5000 x 0 0 0 wlan0\n',
      '99999 0 0 0 0 wlan0\n',
      '5000\n',
      // A line one field short.
      '5000 0 0 0 wlan0\n',
    ]) {
      const hub = watchdogHub();
      hub.remember(memory);
      for (const at of MILESTONES) hub.run(at);
      expect(hub.calls(), memory).toEqual([]);
      expect(hub.log(), memory).toEqual([]);
    }
    // The control: the same calls after a memory it can read do act.
    const hub = watchdogHub();
    hub.remember('5000 0 0 0 0 wlan0\n');
    for (const at of [5120, 5300, 5600]) hub.run(at);
    expect(actions(hub.calls())).toEqual([...RELOAD, RESTART]);
  });

  /**
   * **The memory is root's, and still checked.** The keep-alive writes it, but
   * a value only reaches `ip` as an address and a MAC, each its own argument.
   */
  it('asks nobody from the memory but an address at a MAC', () => {
    const hub = watchdogHub({
      memory: [
        '192.168.0.1 02:00:00:00:00:01 1792009718',
        '192.168.0.9 not-a-mac 1792009718',
        '192.168.0.10 02:00:00:00:00:1 1792009718',
        'proxy 02:00:00:00:00:11 1792009718',
        '192.168.0.12;reboot 02:00:00:00:00:12 1792009718',
        'FE80::13 02:00:00:00:00:13 1792009718',
        `fe80:${':1'.repeat(20)} 02:00:00:00:00:14 1792009718`,
        'fe80::15 02:00:00:00:00:15',
        '',
      ].join('\n'),
    });
    hub.answering(true);
    hub.run(5000);
    hub.answering(false);
    hub.run(5300);
    expect(hub.calls().filter((call) => call.startsWith('ip neigh replace'))).toEqual([
      'ip neigh replace 192.168.0.1 lladdr 02:00:00:00:00:01 nud probe dev wlan0',
      'ip neigh replace fe80::15 lladdr 02:00:00:00:00:15 nud probe dev wlan0',
    ]);
  });

  /**
   * **Seconds since boot, never the wall clock.** A Pi has no RTC, and the
   * jump when timesyncd first corrects it would read as minutes of silence.
   */
  it('keeps time by the uptime, and asks nothing by broadcast', () => {
    const code = readFileSync(WATCHDOG, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line));
    expect(code.some((line) => /\bdate\b/.test(line))).toBe(false);
    expect(readFileSync(WATCHDOG, 'utf8')).toMatch(/GETHOME_UPTIME:-\/proc\/uptime/);
    // The keep-alive's rule: nothing is ever broadcast at a neighbour, and the
    // gateway ping stays gone.
    expect(code.some((line) => /\b(arping|ping)\b/.test(line))).toBe(false);
  });
});

/** Where the installer puts the watchdog, and how the keep-alive reaches it. */
describe('the watchdog in the keep-alive', () => {
  it('installs the watchdog from the build being installed, and bakes in where', () => {
    const result = keepalive({ route: WIFI_ROUTE, wireless: ['wlan0'] });
    expect(result.watchdog).toBe(readFileSync(WATCHDOG, 'utf8'));
    expect(result.watchdogMode).toBe('755');
    expect(result.script).toContain(`wifi_watchdog="${result.watchdogPath}"`);
    expect(result.output).toMatch(/SAY If its Wi-Fi ever stays connected while nothing gets through/);
  });

  it('says what the hub goes without when it cannot be installed', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'gethome-nobuild-'));
    dirs.push(empty);
    const result = keepalive({ route: WIFI_ROUTE, wireless: ['wlan0'], hubDir: empty });
    expect(result.watchdog).toBe('');
    expect(result.output).toMatch(/WARN Could not install the Wi-Fi watchdog/);
    expect(result.output).not.toMatch(/SAY If its Wi-Fi ever stays connected/);
    // The rest of the keep-alive stands, and its round skips what is not there.
    expect(result.script).toContain('wifi_watchdog="/nonexistent"');
    expect(result.unit).toContain('Restart=always');
  });

  it('ends every round with it, after every question the round asked', () => {
    const round = oneRound({ neigh: '192.168.0.145 lladdr 02:00:00:00:01:45 STALE\n' });
    expect(round.calls.at(-1)).toBe('watchdog [wlan0]');
    expect(round.calls.filter((call) => call.startsWith('watchdog'))).toHaveLength(1);
  });

  /** A reload that did not help can leave the hub with no default route, and the watchdog still has to see it. */
  it('calls it with no interface on a round with no default route', () => {
    const round = oneRound({ neigh: '', route: '' });
    expect(round.calls.filter((call) => call.startsWith('watchdog'))).toEqual(['watchdog []']);
    expect(writes(round.calls)).toEqual([]);
  });

  it('goes with an uninstall, and so does its memory', () => {
    const hubctl = readFileSync(path.join(repoRoot, 'deploy', 'gethome-hubctl'), 'utf8');
    expect(hubctl).toContain('/usr/local/lib/gethome-wifi-watchdog.sh');
    expect(hubctl).toContain('/run/gethome-wifi-watchdog');
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
function collisionWarning(options: {
  wifiMhz: string;
  zigbeeChannel?: number;
  /** A memory carried over from an earlier call, to run the hub's *second*
   *  install rather than only its first. */
  notice?: string;
}): string {
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
       # Zigbee2MQTT's files are read as the hub's account; a test cannot switch
       # users, and deploy-hub-account.test.ts pins that it is the account.
       as_service_user() { "$@"; }
       CONF_DIR="$2"
       for fn in read_hub_file find_iw lan_wifi_iface wifi_frequency_mhz zigbee_channel_clear_of_wifi \
                 zigbee_network_channel zigbee_notice_file warn_if_zigbee_jams_wifi; do
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
        GETHOME_ZIGBEE_NOTICE: options.notice ?? path.join(dir, 'zigbee-channel-notice'),
      },
    },
  );
}

/** Where a `collisionWarning` run should keep (or clear) its memory. */
function noticeFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gethome-notice-'));
  dirs.push(dir);
  return path.join(dir, 'zigbee-channel-notice');
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

  /**
   * **Once, not on every update.** `gethome-hubctl update` *is* `install.sh`,
   * and `update-runner.sh` collects `@@WARN@@` into `status.json`, which the
   * hub serves and the iOS app draws on its update checklist — so without a
   * memory this is ninety words about radio physics in front of somebody every
   * time they update a hub that is working, about the one thing they cannot
   * act on without re-pairing their battery devices. The message is worth
   * hearing; hearing it eleven times is what makes it worthless.
   */
  it('says it once, and not again for the same pair', () => {
    const notice = noticeFile();
    const first = collisionWarning({ wifiMhz: '2412', zigbeeChannel: 11, notice });
    expect(first).toContain('WARN');
    expect(existsSync(notice), 'it has to remember having said it').toBe(true);

    // The next update, of a hub where nothing has changed.
    expect(collisionWarning({ wifiMhz: '2412', zigbeeChannel: 11, notice })).toBe('');
  });

  /**
   * **Keyed on the pair, because a move is a different situation.** A router
   * put on another channel, or a network re-formed, may have made this worse
   * or made it go away — and either way the sentence names both frequencies
   * and the channel to move to, so the one already read is about a hub that no
   * longer exists.
   */
  it('says it again when either radio moves', () => {
    const notice = noticeFile();
    expect(collisionWarning({ wifiMhz: '2412', zigbeeChannel: 11, notice })).toContain('WARN');
    // The owner moved the Zigbee network — and not far enough. Wi-Fi 1 is
    // 2412 ± 11, so channel 13 at 2415 MHz is still inside it. That is exactly
    // the case worth saying twice: they acted, and it did not work.
    const moved = collisionWarning({ wifiMhz: '2412', zigbeeChannel: 13, notice });
    expect(moved).toContain('WARN');
    expect(moved).toContain('channel 13');
  });

  /**
   * And a collision that goes away takes the memory with it, so one appearing
   * later is announced afresh rather than swallowed by a note about the last
   * one.
   */
  it('forgets once the two are clear, so a later collision still speaks', () => {
    const notice = noticeFile();
    expect(collisionWarning({ wifiMhz: '2412', zigbeeChannel: 11, notice })).toContain('WARN');
    expect(collisionWarning({ wifiMhz: '2462', zigbeeChannel: 11, notice })).toBe('');
    expect(existsSync(notice), 'no collision, nothing to remember').toBe(false);
    expect(collisionWarning({ wifiMhz: '2412', zigbeeChannel: 11, notice })).toContain('WARN');
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

  /**
   * **A hub on 5 GHz has no 2.4 GHz channel to get away from**, so it gets the
   * guess a hub that could not measure gets. Taken as a distance instead, 5180
   * MHz is furthest from channel 11 — inside Wi-Fi 1, where the home's own
   * 2.4 GHz radio most often is — which is where every dual-band board would
   * otherwise have formed its network.
   */
  it('treats a hub on 5 GHz as having nothing to measure', () => {
    expect(zigbeeChannelFor('5180')).toBe(25);
    expect(zigbeeChannelFor('5745')).toBe(25);
    expect(zigbeeChannelFor('')).toBe(25);
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
    // The branch that creates a missing configuration.yaml asks for the backup
    // before it picks a channel. deploy-hub-account.test.ts runs both cases.
    const installer = readFileSync(INSTALLER, 'utf8');
    const start = installer.indexOf('if ! as_service_user test -e "$Z2M_CONFIG"');
    expect(start).toBeGreaterThan(0);
    const absent = installer.slice(start, installer.indexOf('current="$(read_hub_file "$Z2M_CONFIG")"', start));
    expect(absent.indexOf('coordinator_backup.json')).toBeGreaterThan(0);
    expect(absent.indexOf('coordinator_backup.json')).toBeLessThan(absent.indexOf('zigbee_channel_clear_of_wifi'));
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
