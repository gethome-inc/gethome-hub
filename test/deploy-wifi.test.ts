import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

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

/** `ip neigh help` from the iproute2 a Raspberry Pi OS hub has, which knows `use`. */
const NEIGH_HELP = `Usage: ip neigh { add | del | change | replace }
                { ADDR [ lladdr LLADDR ] [ nud STATE ] proxy ADDR }
                [ dev DEV ] [ router ] [ use ] [ managed ] [ extern_learn ]
                [ protocol PROTO ]`;

/**
 * The same from an `ip` that has never heard of `use` — and still says
 * "Usage", which is why the installer looks for the word rather than the
 * letters.
 */
const NEIGH_HELP_WITHOUT_USE = `Usage: ip neigh { add | del | change | replace }
                { ADDR [ lladdr LLADDR ] [ nud STATE ] | proxy ADDR } [ dev DEV ]`;

/**
 * Run `keep_wifi_reachable` out of install.sh against files the test owns.
 *
 * Returns the unit and the script it writes, or empty strings for the wired
 * hub that must get neither.
 */
function keepalive(options: { route: string; wireless: string[]; arping?: boolean; ipKnowsUse?: boolean }): {
  unit: string;
  script: string;
  scriptMode: string;
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
  mkdirSync(bin, { recursive: true });
  for (const iface of options.wireless) mkdirSync(path.join(net, iface, 'wireless'), { recursive: true });
  const systemctl = path.join(dir, 'systemctl-calls');
  // `ip neigh help` prints to stderr and exits non-zero, the way the real one
  // does — which is the half that would read as "no" under `pipefail`.
  script_(
    path.join(bin, 'ip'),
    `[ "$*" = "neigh help" ] && { printf '%s\\n' "$FAKE_NEIGH_HELP" >&2; exit 255; }
     printf '%s' "$FAKE_ROUTE"`,
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
        FAKE_NEIGH_HELP: options.ipKnowsUse === false ? NEIGH_HELP_WITHOUT_USE : NEIGH_HELP,
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
   * it cannot.** An `ip` that has never heard of `use` fails every call the
   * loop makes, silently, which leaves each phone's record of the hub to expire
   * — the outage itself, behind an install log with nothing in it.
   */
  it('says so when the kernel cannot be asked to re-check a neighbour', () => {
    const result = keepalive({ route: WIFI_ROUTE, wireless: ['wlan0'], ipKnowsUse: false });
    expect(result.output).toMatch(/WARN .*cannot ask the kernel to re-check a neighbour/);
    // The broadcast half still installs: a hub with one of the two is better
    // off than a hub with neither.
    expect(result.script).not.toBe('');
  });

  it('stays quiet about it on an ip that knows use', () => {
    const result = keepalive({ route: WIFI_ROUTE, wireless: ['wlan0'] });
    // Only this warning: whether the arping one fires depends on whether the
    // machine running the suite has a real `/usr/bin/arping` to fail with.
    expect(result.output).not.toMatch(/cannot ask the kernel/);
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
 * `neigh` is what the kernel's neighbour table says (`ip -4 neigh show dev
 * wlan0`), and `state` what the previous rounds remembered. Returns every
 * command the round ran, in order, and what it remembered afterwards.
 */
function oneRound(options: { neigh: string; state?: string }): { calls: string[]; state: string } {
  const written = keepalive({ route: WIFI_ROUTE, wireless: ['wlan0'] });
  const dir = mkdtempSync(path.join(tmpdir(), 'gethome-round-'));
  dirs.push(dir);
  const bin = path.join(dir, 'bin');
  const calls = path.join(dir, 'calls');
  const state = path.join(dir, 'neighbours');
  mkdirSync(bin, { recursive: true });
  script_(
    path.join(bin, 'ip'),
    `echo "ip $*" >> "${calls}"
     case "$*" in
       "route show default") printf '%s' "$FAKE_ROUTE" ;;
       "-4 -o addr show wlan0") echo "3: wlan0    inet 192.168.0.200/24 brd 192.168.0.255 scope global wlan0" ;;
       "-4 neigh show dev wlan0") printf '%s' "$FAKE_NEIGH" ;;
       "-4 neigh show "*" dev wlan0") printf '%s' "$FAKE_NEIGH" | awk -v a="$4" '$1 == a' ;;
     esac`,
  );
  script_(path.join(bin, 'arping'), `echo "arping $*" >> "${calls}"`);
  script_(path.join(bin, 'ping'), `echo "ping $*" >> "${calls}"`);
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
      FAKE_ROUTE: WIFI_ROUTE,
      FAKE_NEIGH: options.neigh,
      GETHOME_KEEPALIVE_ONCE: '1',
      GETHOME_NEIGH_STATE: state,
    },
  });
  return {
    calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : [],
    state: existsSync(state) ? readFileSync(state, 'utf8') : '',
  };
}

/** The commands a round ran that changed anything, minus the reads. */
function writes(calls: string[]): string[] {
  return calls.filter((call) => !/^ip (route show|-4 -o addr show|-4 neigh show)/.test(call));
}

const now = (): number => Math.floor(Date.now() / 1000);

/**
 * **What keeps a phone's record of the hub alive is a question addressed to the
 * phone, and the kernel already knows how to ask one.** A stale neighbour
 * re-checked with `ip neigh change … use` gets an ARP request by unicast five
 * seconds later — measured on the hub: STALE, DELAY, then REACHABLE, and the
 * Mac's entry for the hub back at 1200 seconds from minus 345. Nothing in it is
 * broadcast, so a router sitting on its broadcasts never sees it.
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
      'ip neigh change 192.168.0.145 dev wlan0 use',
      'ip neigh change 192.168.0.166 dev wlan0 use',
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
   * address it had — seeded back as stale, then re-checked, which is a unicast
   * question — and does it on the round it starts with and every sixth after,
   * which is two minutes at 20 seconds a round.
   */
  it('asks about a neighbour the kernel has given up on, at the address it had', () => {
    const round = oneRound({
      neigh: '192.168.0.166 FAILED\n',
      state: `192.168.0.166 02:00:00:00:01:66 ${now() - 600}\n`,
    });
    expect(writes(round.calls)).toContain('ip neigh replace 192.168.0.166 lladdr 02:00:00:00:01:66 nud stale dev wlan0');
    const replace = round.calls.indexOf('ip neigh replace 192.168.0.166 lladdr 02:00:00:00:01:66 nud stale dev wlan0');
    expect(round.calls[replace + 1]).toBe('ip neigh change 192.168.0.166 dev wlan0 use');
    expect(round.state).toContain('192.168.0.166 02:00:00:00:01:66');
    expect(keepalive({ route: WIFI_ROUTE, wireless: ['wlan0'] }).script).toContain('$((round % 6))');
  });

  it('and one the kernel has dropped altogether', () => {
    const round = oneRound({ neigh: '', state: `192.168.0.166 02:00:00:00:01:66 ${now() - 600}\n` });
    expect(writes(round.calls)).toEqual([
      'arping -U -c 1 -I wlan0 192.168.0.200',
      'ip neigh replace 192.168.0.166 lladdr 02:00:00:00:01:66 nud stale dev wlan0',
      'ip neigh change 192.168.0.166 dev wlan0 use',
    ]);
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
    expect(writes(round.calls)).toContain('ip neigh change 192.168.0.145 dev wlan0 use');
    expect(writes(round.calls)).toContain('ip neigh change 192.168.0.166 dev wlan0 use');
    expect(round.state).not.toContain('192.168.0.9 ');
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
       CONF_DIR="$2"
       for fn in find_iw lan_wifi_iface wifi_frequency_mhz zigbee_channel_clear_of_wifi \
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
