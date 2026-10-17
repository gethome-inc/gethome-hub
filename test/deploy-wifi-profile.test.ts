import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * A hub that loses its Wi-Fi profile has to get it back by itself.
 *
 * On 2026-10-12 a hub was unplugged seconds after it was switched on, while
 * NetworkManager was saving its profiles as netplan YAML, and both files were
 * left at 0 bytes. Every boot after that was healthy and off the network —
 * wlan0 "disconnected" for ever, because an empty YAML defines nothing and is
 * not an error — until the SD card was repaired on another computer.
 * `deploy/wifi-profile.sh` keeps a copy of the profile the hub last connected
 * with and puts it back at boot when NetworkManager has none.
 *
 * `deploy/` has no type checker behind it, so this runs the real script — and
 * the installer's own `keep_wifi_profile` — against a fake `nmcli`, `ip`,
 * `nm-online` and `sync`, and directories the test owns, the way
 * `deploy-wifi.test.ts` and `deploy-matter-ble.test.ts` do. The same two
 * portability rules apply: the sed program is built into a variable first, and
 * nothing here reaches for a GNU-only idiom, because this runs under macOS's
 * bash 3.2 and BSD userland as well as CI's.
 */

const repoRoot = path.join(import.meta.dirname, '..');
const INSTALLER = path.join(repoRoot, 'deploy', 'install.sh');
const SCRIPT = path.join(repoRoot, 'deploy', 'wifi-profile.sh');
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

function lines(file: string): string[] {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

const UUID = 'cf593bc2-43d4-31e2-9ea5-937546cda026';
const PSK = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const LOOPBACK = '5bed983f-04fe-40d6-ac35-d4e2d7ea1c75';
/** The network an app told the hub about before a move: a Wi-Fi profile that is not the copy's. */
const DACHA = '0b9c0d4e-0000-4000-8000-0000000000da';

/** The keyfile written by hand on 2026-10-13 to bring the hub back. */
const KETI_KEYFILE = `[connection]
id=Keti
uuid=${UUID}
type=wifi
interface-name=wlan0

[wifi]
mode=infrastructure
ssid=Keti

[wifi-security]
key-mgmt=wpa-psk
psk=${PSK}

[ipv4]
method=auto

[ipv6]
method=ignore
`;

/**
 * What `netplan generate` renders into /run/NetworkManager/system-connections
 * for the network Raspberry Pi Imager set up through cloud-init — captured
 * from netplan 1.1.2. There is no `uuid=` line: NetworkManager derives the
 * UUID from the file's path, so a copy under another name would come back as
 * another connection unless the UUID NetworkManager reports is written in.
 */
const KETI_NETPLAN_RENDER = `[connection]
id=netplan-wlan0-Keti
type=wifi
interface-name=wlan0

[ipv4]
method=auto

[ipv6]
method=ignore

[wifi]
ssid=Keti
mode=infrastructure

[wifi-security]
key-mgmt=wpa-psk
pmf=2
psk=${PSK}
`;

/** An open network, as netplan renders a profile NetworkManager wrote. No password to keep. */
const OPEN_RENDER = `[connection]
id=Open Cafe
type=wifi
uuid=0b9c0d4e-0000-4000-8000-000000000001
interface-name=wlan0

[ipv4]
method=auto

[ipv6]
#Netplan: passthrough override
method=ignore
ip6-privacy=0

[wifi]
ssid=Open Cafe
mode=infrastructure
`;

/** A network the hub joins on its 5 GHz radio — not one wifi.env would keep. */
const FIVE_GHZ_KEYFILE = `[connection]
id=Flat 3 5G
uuid=0b9c0d4e-0000-4000-8000-000000000002
type=wifi

[wifi]
band=a
ssid=Flat 3 5G

[wifi-security]
key-mgmt=wpa-psk
psk=correct horse battery staple
`;

/** A hotspot this machine runs itself — not a network that puts it on anybody's LAN. */
const HOTSPOT_KEYFILE = `[connection]
id=Hotspot
uuid=0b9c0d4e-0000-4000-8000-000000000003
type=wifi

[wifi]
mode=ap
ssid=gethome-setup
`;

interface Hub {
  /** Where the copy lives (`/etc/gethome`). */
  conf: string;
  /** `/etc/NetworkManager/system-connections`. */
  nmDir: string;
  /** `/run/NetworkManager/system-connections`, where netplan renders profiles. */
  runDir: string;
  /** `/etc/netplan`. */
  netplanDir: string;
  /** Put a profile file somewhere and return its path. */
  profile(dir: string, name: string, body: string): string;
  /** What `nmcli -t -f TYPE,UUID,FILENAME connection show --active` answers. */
  active(rows: string[]): void;
  /** What `nmcli -t -f UUID,TYPE connection show` answers: `uuid:type`, one per profile. */
  profiles(rows: string[]): void;
  /** What `nmcli -t -f TYPE,STATE device` answers. */
  devices(rows: string[]): void;
  run(mode: 'backup' | 'restore' | 'forget', env?: Record<string, string>, args?: string[]): string;
  /** Every `nmcli`, `nm-online` and `sync` invocation, in order. */
  nmcli(): string[];
  nmOnline(): string[];
  syncs(): string[];
  /** Environment that points the script at this hub's fakes and directories. */
  env: Record<string, string>;
  /** The copy and the profile put back, '' where there is none. */
  backup(): string;
  restored(): string;
  modeOf(file: string): string;
  backupFile: string;
  restoredFile: string;
}

/**
 * A fake machine: NetworkManager's answers are files the test edits, and
 * `connection load` adds a Wi-Fi profile to them, the way loading a keyfile
 * does. `FAKE_NM_DOWN` is NetworkManager not answering at all, `FAKE_LATE` one
 * whose profiles are not loaded the first time it is asked, and
 * `FAKE_LOAD_FAILS` one that refuses the file.
 */
function hub(): Hub {
  const dir = scratch('gethome-wifiprofile-');
  const bin = path.join(dir, 'bin');
  const state = path.join(dir, 'state');
  const conf = path.join(dir, 'etc', 'gethome');
  const nmDir = path.join(dir, 'etc', 'NetworkManager', 'system-connections');
  const runDir = path.join(dir, 'run', 'NetworkManager', 'system-connections');
  const netplanDir = path.join(dir, 'etc', 'netplan');
  for (const d of [bin, state, conf, nmDir, runDir, netplanDir]) mkdirSync(d, { recursive: true });
  const calls = { nmcli: path.join(dir, 'nmcli-calls'), nmOnline: path.join(dir, 'nm-online-calls'), sync: path.join(dir, 'sync-calls') };
  writeFileSync(path.join(state, 'active'), '');
  writeFileSync(path.join(state, 'profiles'), '');
  writeFileSync(path.join(state, 'devices'), 'wifi:disconnected\nloopback:connected (externally)\n');

  script_(
    path.join(bin, 'nmcli'),
    `echo "$*" >> "${calls.nmcli}"
     [ "$FAKE_NM_DOWN" = "yes" ] && { echo "Error: NetworkManager is not running." >&2; exit 8; }
     case "$*" in
       "-t -f TYPE,UUID,FILENAME connection show --active") cat "${state}/active" ;;
       "-t -f UUID,TYPE connection show")
         if [ "$FAKE_LATE" = "yes" ] && [ ! -f "${state}/asked" ]; then : > "${state}/asked"; exit 0; fi
         cat "${state}/profiles" ;;
       "-t -f TYPE,STATE device") cat "${state}/devices" ;;
       "connection load "*)
         [ "$FAKE_LOAD_FAILS" = "yes" ] && { echo "Error: failed to load connection: invalid key" >&2; exit 1; }
         loaded=$(sed -n 's/^uuid=//p' "$3" | head -n 1)
         echo "\${loaded}:802-11-wireless" >> "${state}/profiles" ;;
       *) echo "unexpected nmcli $*" >&2; exit 2 ;;
     esac
     exit 0`,
  );
  script_(path.join(bin, 'nm-online'), `echo "$*" >> "${calls.nmOnline}"`);
  script_(path.join(bin, 'sync'), `echo "$*" >> "${calls.sync}"`);
  script_(
    path.join(bin, 'ip'),
    `case "$*" in
       "-4 route show default") printf '%s' "$FAKE_ROUTE" ;;
     esac`,
  );

  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    GETHOME_NM_CONNECTIONS: nmDir,
    GETHOME_NETPLAN_DIR: netplanDir,
    GETHOME_NM_WAIT: '1',
    FAKE_ROUTE: '',
    // Whatever the machine running the suite has in its own environment, a
    // dispatcher's variable must not leak in.
    CONNECTION_UUID: '',
  };
  const backupFile = path.join(conf, 'wifi-profile.nmconnection');
  const restoredFile = path.join(nmDir, 'gethome-restored-wifi.nmconnection');

  return {
    conf,
    nmDir,
    runDir,
    netplanDir,
    env,
    backupFile,
    restoredFile,
    profile(where, name, body) {
      const file = path.join(where, name);
      writeFileSync(file, body);
      return file;
    },
    active(rows) {
      writeFileSync(path.join(state, 'active'), rows.map((row) => `${row}\n`).join(''));
    },
    profiles(rows) {
      writeFileSync(path.join(state, 'profiles'), rows.map((row) => `${row}\n`).join(''));
    },
    devices(rows) {
      writeFileSync(path.join(state, 'devices'), rows.map((row) => `${row}\n`).join(''));
    },
    run(mode, extra = {}, args = []) {
      return execFileSync('bash', [SCRIPT, mode, ...args, '--conf', conf], {
        encoding: 'utf8',
        env: { ...process.env, ...env, ...extra },
      });
    },
    nmcli: () => lines(calls.nmcli),
    nmOnline: () => lines(calls.nmOnline),
    syncs: () => lines(calls.sync),
    backup: () => (existsSync(backupFile) ? readFileSync(backupFile, 'utf8') : ''),
    restored: () => (existsSync(restoredFile) ? readFileSync(restoredFile, 'utf8') : ''),
    modeOf: (file) => (statSync(file).mode & 0o777).toString(8),
  };
}

/** A hub on Keti whose profile is the hand-written keyfile. */
function onKeti(): Hub {
  const h = hub();
  const file = h.profile(h.nmDir, 'Keti.nmconnection', KETI_KEYFILE);
  h.active([`802-11-wireless:${UUID}:${file}`]);
  h.profiles([`${UUID}:802-11-wireless`, `${LOOPBACK}:loopback`]);
  h.devices(['wifi:connected', 'loopback:connected (externally)']);
  return h;
}

/** Take the copy, then lose every profile the way the power cut did. */
function stranded(h: Hub = onKeti()): Hub {
  h.run('backup');
  expect(h.backup()).not.toBe('');
  h.active([]);
  h.profiles([`${LOOPBACK}:loopback`]);
  h.devices(['wifi:disconnected', 'loopback:connected (externally)']);
  writeFileSync(path.join(h.netplanDir, `90-NM-${UUID}.yaml`), '');
  return h;
}

describe("keeping a copy of the hub's Wi-Fi profile", () => {
  it('copies the profile NetworkManager is connected with, root-only, under /etc/gethome', () => {
    const h = onKeti();
    const output = h.run('backup');
    expect(h.backup()).toBe(KETI_KEYFILE);
    // It holds the network's key, so nobody but root reads it.
    expect(h.modeOf(h.backupFile)).toBe('600');
    expect(output).toContain('keeps a copy of its Wi-Fi profile (Keti)');
  });

  /**
   * The same hub has had its profile in both of NetworkManager's storages, so
   * the file is whichever one NetworkManager says it loaded the profile from —
   * here netplan's rendering in /run, which carries no UUID of its own.
   */
  it('copies a profile netplan rendered, and gives it the UUID NetworkManager reports', () => {
    const h = hub();
    const file = h.profile(h.runDir, 'netplan-wlan0-Keti.nmconnection', KETI_NETPLAN_RENDER);
    h.active([`802-11-wireless:${UUID}:${file}`]);
    h.run('backup');
    expect(h.backup()).toBe(KETI_NETPLAN_RENDER.replace('[connection]\n', `[connection]\nuuid=${UUID}\n`));
  });

  it('asks NetworkManager where the profile is rather than assuming a path', () => {
    const h = onKeti();
    h.run('backup');
    expect(h.nmcli()).toContain('-t -f TYPE,UUID,FILENAME connection show --active');
  });

  it("decodes a file name nmcli has escaped", () => {
    // `nmcli -t` escapes `:` and `\` inside a value; a keyfile is named after
    // its profile, and a profile can be named anything.
    const h = hub();
    const file = h.profile(h.nmDir, 'Flat:3.nmconnection', KETI_KEYFILE);
    h.active([`802-11-wireless:${UUID}:${file.replace(/:/g, '\\:')}`]);
    h.run('backup');
    expect(h.backup()).toBe(KETI_KEYFILE);
  });

  it('keeps an open network, which wifi.env deliberately does not', () => {
    const h = hub();
    const file = h.profile(h.runDir, 'netplan-NM-open.nmconnection', OPEN_RENDER);
    h.active([`802-11-wireless:0b9c0d4e-0000-4000-8000-000000000001:${file}`]);
    h.run('backup');
    expect(h.backup()).toBe(OPEN_RENDER);
  });

  it('keeps a network only 5 GHz can see, which wifi.env deliberately does not', () => {
    const h = hub();
    const file = h.profile(h.nmDir, 'Flat 3 5G.nmconnection', FIVE_GHZ_KEYFILE);
    h.active([`802-11-wireless:0b9c0d4e-0000-4000-8000-000000000002:${file}`]);
    h.run('backup');
    expect(h.backup()).toBe(FIVE_GHZ_KEYFILE);
  });

  /**
   * Run from the dispatcher, the connection that just came up is the one in
   * `CONNECTION_UUID` — and on a hub with a cable in, that is often Ethernet.
   */
  it('keeps the connection the dispatcher names, and nothing for Ethernet coming up', () => {
    const h = onKeti();
    h.active(['802-3-ethernet:0b9c0d4e-0000-4000-8000-0000000000e0:/etc/NetworkManager/system-connections/Wired.nmconnection', `802-11-wireless:${UUID}:${path.join(h.nmDir, 'Keti.nmconnection')}`]);
    h.run('backup', { CONNECTION_UUID: '0b9c0d4e-0000-4000-8000-0000000000e0' });
    expect(h.backup()).toBe('');
    h.run('backup', { CONNECTION_UUID: UUID });
    expect(h.backup()).toBe(KETI_KEYFILE);
  });

  /**
   * Atomic and durable, because the copy must never be the thing a power cut
   * empties: a temporary file, fsynced, renamed over the old one, and the
   * directory fsynced so the rename survives too.
   */
  it('writes the copy through an fsynced temporary file and leaves none behind', () => {
    const h = onKeti();
    h.run('backup');
    const syncs = h.syncs();
    expect(syncs).toHaveLength(2);
    expect(path.dirname(syncs[0]!)).toBe(h.conf);
    expect(path.basename(syncs[0]!)).toMatch(/^\.gethome-wifi-profile\./);
    expect(existsSync(syncs[0]!)).toBe(false);
    expect(syncs[1]).toBe(h.conf);
    expect(readdirSync(h.conf)).toEqual(['wifi-profile.nmconnection']);
  });

  it('writes nothing when the profile has not changed', () => {
    // The dispatcher runs on every association; a write each time would be a
    // card write for nothing, and a window.
    const h = onKeti();
    h.run('backup');
    const before = statSync(h.backupFile);
    const output = h.run('backup');
    expect(output).toContain('up to date');
    expect(h.syncs()).toHaveLength(2);
    expect(statSync(h.backupFile).mtimeMs).toBe(before.mtimeMs);
  });

  it("follows a profile the owner has changed, the next time it connects", () => {
    const h = onKeti();
    h.run('backup');
    const changed = KETI_KEYFILE.replace(PSK, 'a new password');
    h.profile(h.nmDir, 'Keti.nmconnection', changed);
    h.run('backup');
    expect(h.backup()).toBe(changed);
  });

  describe('never replaces a good copy with one that could not reconnect the hub', () => {
    function withGoodCopy(): Hub {
      const h = onKeti();
      h.run('backup');
      return h;
    }

    it('not with an empty file', () => {
      const h = withGoodCopy();
      h.profile(h.nmDir, 'Keti.nmconnection', '');
      expect(h.run('backup')).toContain('left as it was');
      expect(h.backup()).toBe(KETI_KEYFILE);
    });

    it('not with a hotspot this machine runs', () => {
      const h = withGoodCopy();
      const file = h.profile(h.nmDir, 'Hotspot.nmconnection', HOTSPOT_KEYFILE);
      h.active([`802-11-wireless:0b9c0d4e-0000-4000-8000-000000000003:${file}`]);
      expect(h.run('backup')).toContain('hotspot');
      expect(h.backup()).toBe(KETI_KEYFILE);
    });

    it('not with a file that is some other connection', () => {
      const h = withGoodCopy();
      const file = h.profile(h.nmDir, 'Other.nmconnection', FIVE_GHZ_KEYFILE);
      h.active([`802-11-wireless:${UUID}:${file}`]);
      h.run('backup');
      expect(h.backup()).toBe(KETI_KEYFILE);
    });

    it('not with a profile that lives only in memory', () => {
      const h = withGoodCopy();
      h.active([`802-11-wireless:${UUID}:`]);
      h.run('backup');
      expect(h.backup()).toBe(KETI_KEYFILE);
    });
  });

  it('keeps the network the hub joins when a hotspot is listed first', () => {
    const h = onKeti();
    const hotspot = h.profile(h.nmDir, 'Hotspot.nmconnection', HOTSPOT_KEYFILE);
    h.active([`802-11-wireless:0b9c0d4e-0000-4000-8000-000000000003:${hotspot}`, `802-11-wireless:${UUID}:${path.join(h.nmDir, 'Keti.nmconnection')}`]);
    h.run('backup');
    expect(h.backup()).toBe(KETI_KEYFILE);
  });

  it('keeps nothing on a hub that is not on Wi-Fi', () => {
    const h = hub();
    h.active(['802-3-ethernet:0b9c0d4e-0000-4000-8000-0000000000e0:/etc/NetworkManager/system-connections/Wired.nmconnection']);
    expect(h.run('backup')).toContain('not on Wi-Fi');
    expect(h.backup()).toBe('');
  });

  it('changes nothing when NetworkManager does not answer', () => {
    const h = onKeti();
    h.run('backup');
    expect(h.run('backup', { FAKE_NM_DOWN: 'yes' })).toContain('did not answer');
    expect(h.backup()).toBe(KETI_KEYFILE);
  });
});

describe('putting the profile back at boot', () => {
  /** The outage itself: the copy exists, NetworkManager has no Wi-Fi profile, nothing else is up. */
  it('puts the copy back when NetworkManager has no Wi-Fi profile at all', () => {
    const h = stranded();
    const output = h.run('restore');
    expect(h.restored()).toContain(KETI_KEYFILE);
    expect(h.restored()).toMatch(/^# Put back by GetHome/);
    // NetworkManager refuses a keyfile anybody but root can read.
    expect(h.modeOf(h.restoredFile)).toBe('600');
    expect(h.nmcli()).toContain(`connection load ${h.restoredFile}`);
    expect(output).toContain('put back the one it last connected with (Keti)');
  });

  it('puts back a profile netplan rendered as the same connection it was', () => {
    const h = hub();
    const file = h.profile(h.runDir, 'netplan-wlan0-Keti.nmconnection', KETI_NETPLAN_RENDER);
    h.active([`802-11-wireless:${UUID}:${file}`]);
    h.profiles([`${UUID}:802-11-wireless`]);
    stranded(h);
    h.run('restore');
    expect(h.restored()).toContain(`[connection]\nuuid=${UUID}\nid=netplan-wlan0-Keti\n`);
    expect(h.restored()).toContain(`psk=${PSK}`);
  });

  it('writes it through an fsynced temporary file, beside NetworkManager’s own', () => {
    const h = stranded();
    const before = h.syncs().length;
    h.run('restore');
    const syncs = h.syncs().slice(before);
    expect(syncs).toHaveLength(2);
    expect(path.dirname(syncs[0]!)).toBe(h.nmDir);
    // A dot-file, which NetworkManager never loads, even half-written.
    expect(path.basename(syncs[0]!)).toMatch(/^\./);
    expect(syncs[1]).toBe(h.nmDir);
    expect(readdirSync(h.nmDir).filter((name) => name.startsWith('.'))).toEqual([]);
  });

  /**
   * An empty YAML defines nothing, and one with zeros in it makes `netplan
   * generate` refuse the whole directory. Both are named, and both are left
   * where they are: /etc/netplan is the distribution's.
   */
  it('names the damaged netplan files and leaves them where they are', () => {
    const h = stranded();
    const zeros = path.join(h.netplanDir, '90-NM-75a1216a.yaml');
    writeFileSync(zeros, Buffer.alloc(300));
    writeFileSync(path.join(h.netplanDir, '50-cloud-init.yaml'), 'network:\n  version: 2\n');
    const output = h.run('restore');
    expect(output).toContain(`${path.join(h.netplanDir, `90-NM-${UUID}.yaml`)} (empty)`);
    expect(output).toContain(`${zeros} (zeros where the data should be)`);
    expect(output).not.toContain('50-cloud-init.yaml');
    expect(readdirSync(h.netplanDir).sort()).toEqual(['50-cloud-init.yaml', '90-NM-75a1216a.yaml', `90-NM-${UUID}.yaml`]);
  });

  /**
   * After a restore, the next copy is taken from the restored file itself, so
   * a second loss must not stack a second note on top of the first.
   */
  it('survives a second loss the same way, with one note at the top', () => {
    const h = stranded();
    h.run('restore');
    h.active([`802-11-wireless:${UUID}:${h.restoredFile}`]);
    h.profiles([`${UUID}:802-11-wireless`]);
    h.run('backup');
    expect(h.backup()).toBe(h.restored());
    stranded(h);
    h.run('restore');
    expect(h.restored().match(/# Put back by GetHome/g)).toHaveLength(1);
    expect(h.restored()).toContain(KETI_KEYFILE);
  });

  it('replaces an earlier restore that has itself been emptied', () => {
    const h = stranded();
    writeFileSync(h.restoredFile, '');
    h.run('restore');
    expect(h.restored()).toContain(KETI_KEYFILE);
  });

  /**
   * A hub can know more than one network — an app adds the one it is about to
   * be moved to — and a cut that empties the profile for the network it stands
   * on strands it just the same while the other survives. Out of range, that
   * other one cannot put the hub on a network; in range, it already would have.
   */
  it('puts the copy back when another Wi-Fi profile survived but the one it last joined did not', () => {
    const h = stranded();
    h.profiles([`${DACHA}:802-11-wireless`, `${LOOPBACK}:loopback`]);
    const output = h.run('restore');
    expect(h.restored()).toContain(KETI_KEYFILE);
    expect(h.nmcli()).toContain(`connection load ${h.restoredFile}`);
    expect(output).toContain('put back the one it last connected with (Keti)');
  });

  it('says so when NetworkManager will not load it', () => {
    const h = stranded();
    const output = h.run('restore', { FAKE_LOAD_FAILS: 'yes' });
    expect(output).toContain('would not load');
    expect(output).toContain('invalid key');
  });

  describe('leaves alone', () => {
    it('a hub that has a Wi-Fi profile, and asks nothing more of a healthy boot', () => {
      const h = onKeti();
      h.run('backup');
      const output = h.run('restore');
      expect(output).toContain('still has the Wi-Fi profile the hub last connected with (Keti)');
      expect(h.restored()).toBe('');
      expect(h.nmcli().filter((call) => call.startsWith('connection load'))).toEqual([]);
      // The ordinary boot answers at once and does not wait for NetworkManager.
      expect(h.nmOnline()).toEqual([]);
    });

    it('the network it last joined, among others it knows', () => {
      const h = stranded();
      h.profiles([`${DACHA}:802-11-wireless`, `${UUID}:802-11-wireless`, `${LOOPBACK}:loopback`]);
      expect(h.run('restore')).toContain('nothing to put back');
      expect(h.restored()).toBe('');
    });

    it('a profile for that network the owner has changed — same connection, still there', () => {
      // A new password or an edited setting keeps the UUID, and it is theirs:
      // it becomes the copy the next time it connects.
      const h = stranded();
      h.profiles([`${UUID.toUpperCase()}:802-11-wireless`]);
      h.run('restore');
      expect(h.restored()).toBe('');
    });

    it('a hub another network it knows has already put on the network', () => {
      const h = stranded();
      h.profiles([`${DACHA}:802-11-wireless`]);
      const output = h.run('restore', { FAKE_ROUTE: 'default via 10.0.0.1 dev wlan0 proto dhcp metric 600\n' });
      expect(output).toContain('on the network another way');
      expect(h.restored()).toBe('');
    });

    it('a profile NetworkManager had not finished loading when first asked', () => {
      // Only a boot with no Wi-Fi profile waits for NetworkManager to finish
      // starting, and then asks again before deciding anything.
      const h = stranded();
      h.profiles([`${UUID}:802-11-wireless`]);
      const output = h.run('restore', { FAKE_LATE: 'yes' });
      expect(h.nmOnline()).toEqual(['-s -q -t 1']);
      expect(output).toContain('still has the Wi-Fi profile the hub last connected with');
      expect(h.restored()).toBe('');
    });

    it('a hub that is on the network another way', () => {
      const h = stranded();
      const output = h.run('restore', { FAKE_ROUTE: 'default via 192.168.0.1 dev eth0 proto dhcp metric 100\n' });
      expect(output).toContain('on the network another way');
      expect(h.restored()).toBe('');
    });

    it('a hub with Ethernet coming up, even before it has a route', () => {
      const h = stranded();
      h.devices(['ethernet:connecting (getting IP configuration)', 'wifi:disconnected']);
      h.run('restore');
      expect(h.restored()).toBe('');
    });

    it('a machine with no Wi-Fi radio', () => {
      const h = stranded();
      h.devices(['ethernet:unavailable', 'loopback:connected (externally)']);
      expect(h.run('restore')).toContain('no Wi-Fi radio');
      expect(h.restored()).toBe('');
    });

    /** No answer is not "no profiles": the two must never be confused. */
    it('everything, when NetworkManager does not answer', () => {
      const h = stranded();
      expect(h.run('restore', { FAKE_NM_DOWN: 'yes' })).toContain('did not answer');
      expect(h.restored()).toBe('');
    });

    it('everything, when the copy is not a network the hub could join', () => {
      const h = stranded();
      writeFileSync(h.backupFile, HOTSPOT_KEYFILE);
      expect(h.run('restore')).toContain('not one the hub could reconnect with');
      expect(h.restored()).toBe('');
    });

    it('everything, when there is no copy', () => {
      const h = hub();
      expect(h.run('restore')).toContain('nothing to put back');
      expect(h.restored()).toBe('');
      expect(h.nmcli()).toEqual([]);
    });
  });
});

/**
 * A network removed through the hub (`deploy/wifi-networks.sh`) must not come
 * back from the copy. The hub never removes the network it is on, so the copy
 * can be of a removed network only on a board reached another way — Ethernet —
 * and there it would put that network back the first boot the cable was out.
 */
describe('forgetting a network removed through the hub', () => {
  it('drops the copy when it is of the network removed', () => {
    const h = onKeti();
    h.run('backup');
    const syncs = h.syncs().length;
    const output = h.run('forget', {}, [UUID]);
    expect(h.backup()).toBe('');
    expect(output).toContain('no longer keeps a copy of Keti');
    // The removal is on the card before it is reported.
    expect(h.syncs().slice(syncs)).toEqual([h.conf]);
  });

  it('matches the UUID whatever its case', () => {
    const h = onKeti();
    h.run('backup');
    h.run('forget', {}, [UUID.toUpperCase()]);
    expect(h.backup()).toBe('');
  });

  it('keeps the copy when another network was removed', () => {
    const h = onKeti();
    h.run('backup');
    expect(h.run('forget', {}, [DACHA])).toContain('of another network');
    expect(h.backup()).toBe(KETI_KEYFILE);
  });

  it('touches nothing for a word that is not a UUID', () => {
    const h = onKeti();
    h.run('backup');
    expect(h.run('forget', {}, ['../../etc/passwd'])).toContain('not a connection UUID');
    expect(h.run('forget')).toContain('not a connection UUID');
    expect(h.backup()).toBe(KETI_KEYFILE);
  });

  it('says nothing and changes nothing when there is no copy', () => {
    const h = hub();
    expect(h.run('forget', {}, [UUID])).toBe('');
    expect(h.nmcli()).toEqual([]);
  });

  it('never asks NetworkManager anything', () => {
    const h = onKeti();
    h.run('backup');
    const before = h.nmcli().length;
    h.run('forget', {}, [UUID]);
    expect(h.nmcli()).toHaveLength(before);
  });
});

interface Installed {
  output: string;
  helper: string;
  dispatcher: string;
  unit: string;
  systemctl: string[];
  hub: Hub;
}

/** Run `keep_wifi_profile` out of install.sh against files the test owns. */
function install(options: { networkManager?: boolean; onWifi?: boolean } = {}): Installed {
  const h = options.onWifi === false ? hub() : onKeti();
  const dir = scratch('gethome-wifiprofile-install-');
  const helper = path.join(dir, 'lib', 'gethome-wifi-profile.sh');
  const dispatcher = path.join(dir, 'dispatcher.d', '53-gethome-wifi-profile');
  const unit = path.join(dir, 'systemd', 'gethome-wifi-restore.service');
  const systemctl = path.join(dir, 'systemctl-calls');
  const bin = path.join(dir, 'bin');
  mkdirSync(path.dirname(helper), { recursive: true });
  mkdirSync(path.dirname(unit), { recursive: true });
  mkdirSync(bin, { recursive: true });
  script_(path.join(bin, 'systemctl'), `echo "$*" >> "${systemctl}"`);

  // No NetworkManager is a PATH holding only the fakes, without `nmcli` — and
  // without the host's own, whatever the machine running the suite has. It is
  // switched to after the function has been lifted out, which needs `sed`.
  const fakeBin = h.env.PATH!.split(':')[0]!;
  if (options.networkManager === false) rmSync(path.join(fakeBin, 'nmcli'));
  const runPath = options.networkManager === false ? `${bin}:${fakeBin}` : `${bin}:${h.env.PATH}`;

  const output = execFileSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
       SUDO=""
       say()  { printf 'SAY %s\\n' "$*"; }
       warn() { printf 'WARN %s\\n' "$*"; }
       fn=keep_wifi_profile
       # Built first: see deploy-wifi.test.ts for what bash 3.2 does otherwise.
       prog="/^$fn() {/,/^}/p"
       eval "$(sed -n "$prog" "$1")"
       PATH="$RUN_PATH"
       keep_wifi_profile`,
      'bash',
      INSTALLER,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...h.env,
        PATH: `${bin}:${h.env.PATH}`,
        RUN_PATH: runPath,
        HUB_DIR: repoRoot,
        CONF_DIR: h.conf,
        GETHOME_WIFI_PROFILE_BIN: helper,
        GETHOME_WIFI_PROFILE_DISPATCHER: dispatcher,
        GETHOME_WIFI_RESTORE_UNIT: unit,
      },
    },
  );
  return {
    output,
    helper: existsSync(helper) ? readFileSync(helper, 'utf8') : '',
    dispatcher: existsSync(dispatcher) ? readFileSync(dispatcher, 'utf8') : '',
    unit: existsSync(unit) ? readFileSync(unit, 'utf8') : '',
    systemctl: lines(systemctl),
    hub: h,
  };
}

describe('installing it', () => {
  it('installs the helper, a dispatcher NetworkManager will run, and the boot oneshot', () => {
    const result = install();
    expect(result.helper).toBe(readFileSync(SCRIPT, 'utf8'));
    expect(result.dispatcher).toContain('[ "$2" = "up" ] || exit 0');
    expect(result.dispatcher).toContain(`backup --conf ${result.hub.conf} --quiet`);
  });

  it('orders the oneshot after NetworkManager without starting NetworkManager', () => {
    const { unit, hub: h } = install();
    expect(unit).toContain('After=NetworkManager.service');
    expect(unit).not.toMatch(/^(Wants|Requires)=/m);
    expect(unit).toContain('Type=oneshot');
    expect(unit).toMatch(new RegExp(`^ExecStart=\\S+/gethome-wifi-profile\\.sh restore --conf ${h.conf}$`, 'm'));
    expect(unit).toContain(`ConditionPathExists=${h.backupFile}`);
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it('enables it for the next boot and does not run it now', () => {
    const { systemctl } = install();
    expect(systemctl).toContain('enable gethome-wifi-restore');
    expect(systemctl.filter((call) => /\b(start|restart)\b|--now/.test(call))).toEqual([]);
  });

  it('keeps a copy at once, so a hub nobody reconnects is covered from tonight', () => {
    const result = install();
    expect(result.hub.backup()).toBe(KETI_KEYFILE);
    expect(result.output).toContain('keeps a copy of its Wi-Fi profile (Keti)');
  });

  it('is installed on a wired hub too, and keeps nothing there', () => {
    const result = install({ onWifi: false });
    expect(result.unit).not.toBe('');
    expect(result.hub.backup()).toBe('');
    expect(result.output).not.toContain('WARN');
  });

  it('installs nothing and says nothing on a machine with no NetworkManager', () => {
    const result = install({ networkManager: false });
    expect(result.helper).toBe('');
    expect(result.dispatcher).toBe('');
    expect(result.unit).toBe('');
    expect(result.output).toBe('');
  });

  /** And the dispatcher itself, run the way NetworkManager runs it: interface, then action. */
  it('the dispatcher keeps a copy when a connection comes up, and only then', () => {
    const result = install();
    const h = result.hub;
    rmSync(h.backupFile);
    const dispatcher = path.join(scratch('gethome-wifiprofile-dispatch-'), 'dispatch');
    writeFileSync(dispatcher, result.dispatcher);
    chmodSync(dispatcher, 0o755);
    const invoke = (action: string): void => {
      execFileSync('sh', [dispatcher, 'wlan0', action], {
        encoding: 'utf8',
        env: { ...process.env, ...h.env, CONNECTION_UUID: UUID },
      });
    };
    invoke('down');
    invoke('dhcp4-change');
    expect(h.backup()).toBe('');
    invoke('up');
    expect(h.backup()).toBe(KETI_KEYFILE);
  });
});

describe('taking it away again', () => {
  const hubctl = readFileSync(path.join(repoRoot, 'deploy', 'gethome-hubctl'), 'utf8');

  it('uninstall removes the unit, the dispatcher and the helper', () => {
    expect(hubctl).toContain('gethome-wifi-restore.service');
    expect(hubctl).toContain('/etc/NetworkManager/dispatcher.d/53-gethome-wifi-profile');
    expect(hubctl).toContain('/usr/local/lib/gethome-wifi-profile.sh');
  });

  it('uninstall leaves a profile it put back, which is the machine’s Wi-Fi by then', () => {
    expect(hubctl).not.toContain('gethome-restored-wifi');
  });
});
