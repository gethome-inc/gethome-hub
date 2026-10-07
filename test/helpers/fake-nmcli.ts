import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A NetworkManager for `deploy/wifi-networks.sh` to talk to, shared by the
 * suite that drives the script on its own and the one that drives it from
 * behind the hub's routes — so both are testing the same pretend machine.
 */

export const WIFI_NETWORKS_SCRIPT = path.resolve(import.meta.dirname, '../../deploy/wifi-networks.sh');

export interface Profile {
  uuid: string;
  type: string;
  active: boolean;
  name: string;
  ssid: string;
}

/**
 * A NetworkManager that keeps its profiles in a tab-separated file and answers
 * the handful of questions the script asks, the way nmcli answers them. Every
 * call is recorded one argument per line, so a test can see exactly what a
 * network name reached nmcli as.
 */
export const FAKE_NMCLI = `#!/usr/bin/env bash
state="$FAKE_NM_DIR/profiles"
touch "$state"
{ printf '%s\\n' '---'; printf '%s\\n' "$@"; } >> "$FAKE_NM_DIR/calls"
tab=$(printf '\\t')
case "$*" in
  "-t -f UUID,TYPE,ACTIVE connection show")
    while IFS="$tab" read -r uuid type active name ssid; do
      [ -n "$uuid" ] && printf '%s:%s:%s\\n' "$uuid" "$type" "$active"
    done < "$state" ;;
  "-t -f UUID,NAME connection show")
    while IFS="$tab" read -r uuid type active name ssid; do
      [ -n "$uuid" ] && printf '%s:%s\\n' "$uuid" "$name"
    done < "$state" ;;
  "-e no -g 802-11-wireless.ssid connection show uuid "*)
    for want in "$@"; do :; done
    while IFS="$tab" read -r uuid type active name ssid; do
      [ "$uuid" = "$want" ] && printf '%s\\n' "$ssid"
    done < "$state" ;;
  "-t -f DEVICE,TYPE device")
    [ "$FAKE_NO_WIFI_DEVICE" = 1 ] || printf 'wlan0:wifi\\n'
    printf 'eth0:ethernet\\n' ;;
  "connection add "*)
    if [ "$FAKE_ADD_FAILS" = 1 ]; then
      echo "Error: Failed to add 'x' connection: 802-11-wireless-security.psk: property is invalid" >&2
      exit 4
    fi
    shift 2
    name=""; ssid=""
    while [ $# -gt 0 ]; do
      case "$1" in
        con-name) name="$2"; shift 2 ;;
        ssid) ssid="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    n=$(( $(wc -l < "$state") + 1 ))
    uuid=$(printf 'feedface-0000-0000-0000-%012d' "$n")
    printf '%s\\t802-11-wireless\\tno\\t%s\\t%s\\n' "$uuid" "$name" "$ssid" >> "$state"
    echo "Connection '$name' ($uuid) successfully added." ;;
  "connection delete uuid "*)
    for want in "$@"; do :; done
    grep -v "^$want$tab" "$state" > "$state.new"; mv "$state.new" "$state"
    echo "Connection successfully deleted." ;;
esac
exit 0
`;

export interface Machine {
  conf: string;
  data: string;
  nm: string;
  bin: string;
}

export function machine(
  tmp: () => string,
  profiles: Profile[],
  options: { nmcli?: boolean; data?: string } = {},
): Machine {
  const conf = tmp();
  const data = options.data ?? tmp();
  const nm = tmp();
  const bin = tmp();
  writeFileSync(path.join(conf, 'hub.env'), `DATA_DIR=${data}\nPORT=8420\n`);
  mkdirSync(path.join(data, 'wifi'), { recursive: true });
  writeFileSync(
    path.join(nm, 'profiles'),
    profiles
      .map((p) => `${p.uuid}\t${p.type}\t${p.active ? 'yes' : 'no'}\t${p.name}\t${p.ssid}\n`)
      .join(''),
  );
  if (options.nmcli !== false) {
    writeFileSync(path.join(bin, 'nmcli'), FAKE_NMCLI);
    chmodSync(path.join(bin, 'nmcli'), 0o755);
  }
  return { conf, data, nm, bin };
}

function scriptEnv(m: Machine, env: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GETHOME_CONF: m.conf,
    // Not a group the test user belongs to on every machine, which is the
    // point: a chgrp that fails must not stop the file being written.
    GETHOME_GROUP: 'gethome-test-nonexistent',
    FAKE_NM_DIR: m.nm,
    // `nmcli` must be the fake or nothing at all, never the real one on a
    // developer's Linux machine.
    PATH: `${m.bin}:/usr/bin:/bin`,
    ...env,
  };
}

/** Run the real script, as the path unit would, and return its exit status. */
export function runWifiScript(m: Machine, args: string[] = [], env: Record<string, string> = {}): number {
  try {
    execFileSync('bash', [WIFI_NETWORKS_SCRIPT, ...args], {
      env: scriptEnv(m, env),
      stdio: 'ignore',
    });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? -1;
  }
}

export function profilesOf(m: Machine): Profile[] {
  return readFileSync(path.join(m.nm, 'profiles'), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [uuid, type, active, name, ssid] = line.split('\t') as [string, string, string, string, string];
      return { uuid, type, active: active === 'yes', name, ssid };
    });
}

/** Each nmcli call as its argument list. */
export function callsOf(m: Machine): string[][] {
  const file = path.join(m.nm, 'calls');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('---\n')
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => chunk.replace(/\n$/, '').split('\n'));
}

/**
 * Stand in for `gethome-wifi.path`: run the script whenever the hub leaves a
 * request, until stopped. Asynchronous, so a route can be waiting on the
 * outcome while the script produces it.
 */
export function watchForRequests(m: Machine, env: Record<string, string> = {}): () => void {
  const request = path.join(m.data, 'wifi', 'request');
  let running = false;
  const timer = setInterval(() => {
    if (running || !existsSync(request)) return;
    running = true;
    execFile('bash', [WIFI_NETWORKS_SCRIPT, '--quiet'], { env: scriptEnv(m, env) }, () => {
      running = false;
    });
  }, 20);
  return () => clearInterval(timer);
}
