import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brokerPasswordHash } from '../../src/core/mqtt-device-accounts.js';

/**
 * The broker's side of a device's own account, staged for
 * `deploy/mqtt-accounts.sh` to work on — shared by the suite that runs a real
 * broker on it, the one that drives it from behind the hub's routes, and the
 * one that asks the script hard questions on its own. All three run the real
 * script, so the format the hub writes and the format the script reads are
 * never tested apart.
 */

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const MQTT_ACCOUNTS_SCRIPT = path.join(repoRoot, 'deploy', 'mqtt-accounts.sh');

const installer = readFileSync(path.join(repoRoot, 'deploy', 'install.sh'), 'utf8');

/** One of `install.sh`'s heredocs, by its delimiter. */
export function installerHeredoc(delimiter: string): string {
  const match = installer.match(new RegExp(`<<'?${delimiter}'?\\n([\\s\\S]*?)\\n${delimiter}\\n`));
  if (!match) throw new Error(`heredoc ${delimiter} not found in install.sh`);
  return match[1]!;
}

/** The ACL exactly as `install.sh` writes it, with the two account names filled in. */
export function installerAcl(hubUser = 'gethome-hub', appUser = 'gethome'): string {
  return installerHeredoc('MOSQACL')
    .split('${MQTT_HUB_USER}')
    .join(hubUser)
    .split('${MQTT_APP_USER}')
    .join(appUser);
}

/** Who a command names as `name`, or undefined where there is no such account. */
function account(name: string): { name: string; uid: number; gid: number } | undefined {
  try {
    const uid = Number(execFileSync('id', ['-u', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    const gid = Number(execFileSync('id', ['-g', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    return Number.isInteger(uid) && Number.isInteger(gid) ? { name, uid, gid } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * **The account the broker reads its files as, in this run of the suite.**
 *
 * On a hub that is `mosquitto`, and both writers hand the two files to it and
 * its primary group, because that is who mosquitto checks them against. Here
 * it depends on who runs the suite. As root — and with mosquitto installed —
 * a broker this suite starts drops to `mosquitto` exactly as a hub's does, so
 * that is the account. As anybody else nothing drops anything: the broker
 * runs as whoever started it, and that is the account, which is also the only
 * one a file can be handed to without root. Either way the files are handed
 * to the account that will read them, so what a hub's broker would say about
 * them, this one says too.
 */
export function brokerAccount(): { name: string; uid: number; gid: number } {
  const self = userInfo();
  if (self.uid === 0) {
    const mosquitto = account('mosquitto');
    if (mosquitto) return mosquitto;
  }
  return { name: self.username, uid: self.uid, gid: self.gid };
}

export interface BrokerMachine {
  /** Stands in for /etc/gethome: `hub.env` names the data directory. */
  conf: string;
  /** The hub's data directory; the list lives in `mqtt-accounts/` under it. */
  data: string;
  /** Stands in for /etc/mosquitto. */
  etc: string;
  passwd: string;
  acl: string;
}

/**
 * A machine `install.sh` has just finished with: the ACL it writes, a password
 * file holding the broker's own two accounts, and the capability file.
 *
 * `passwdLines` are the broker's own accounts as the file holds them. Left
 * out, they are hashed here the way the hub hashes a device's — which the
 * script never looks inside; it copies those two lines as it finds them.
 */
export function brokerMachine(
  tmp: () => string,
  options: { data?: string; passwdLines?: string[]; enabled?: boolean } = {},
): BrokerMachine {
  const conf = tmp();
  const data = options.data ?? tmp();
  const etc = tmp();
  writeFileSync(path.join(conf, 'hub.env'), `DATA_DIR=${data}\nPORT=8420\n`);
  mkdirSync(path.join(data, 'mqtt-accounts'), { recursive: true });
  if (options.enabled !== false) writeFileSync(path.join(data, 'mqtt-accounts', 'enabled'), '');
  const passwd = path.join(etc, 'gethome.passwd');
  const acl = path.join(etc, 'gethome.acl');
  writeFileSync(
    passwd,
    `${(
      options.passwdLines ?? [
        `gethome-hub:${brokerPasswordHash('hub-secret')}`,
        `gethome:${brokerPasswordHash('integration-secret')}`,
      ]
    ).join('\n')}\n`,
  );
  writeFileSync(acl, `${installerAcl()}\n`);
  // As the installer leaves them: the broker account's own, and nobody else's.
  const broker = brokerAccount();
  chmodSync(etc, 0o755);
  for (const file of [passwd, acl]) {
    chmodSync(file, 0o600);
    if (broker.uid !== userInfo().uid) chownSync(file, broker.uid, broker.gid);
  }
  return { conf, data, etc, passwd, acl };
}

function scriptEnv(m: BrokerMachine, env: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GETHOME_CONF: m.conf,
    // The script reads and writes the data directory as the hub's account. The
    // staged directory belongs to whoever runs the suite, so that is the
    // account — the rule `fake-nmcli.ts` states for the Wi-Fi script.
    GETHOME_USER: userInfo().username,
    GETHOME_MQTT_PASSWD: m.passwd,
    GETHOME_MQTT_ACL: m.acl,
    // And the broker's account, as install.sh tells the script on a hub.
    GETHOME_MQTT_USER: brokerAccount().name,
    ...env,
  };
}

/**
 * Run the installer's own `write_broker_files` on this machine's two files —
 * the code that writes them on every install and update, not a copy of what
 * it does — with the broker's two accounts and their passwords, and return
 * its exit status: 0 written, 1 the password file could not be, 2 not made
 * the broker's, 3 not put in place.
 *
 * `passwdTool` is the `mosquitto_passwd` to run, since the installer calls it
 * by name and a Mac's is not on the default PATH of a child process.
 */
export function runInstallerBrokerFiles(
  m: BrokerMachine,
  options: { passwdTool: string; hubPassword: string; appPassword: string; brokerUser?: string },
): number {
  try {
    execFileSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
         SUDO=""
         MQTT_HUB_USER=gethome-hub
         MQTT_APP_USER=gethome
         MQTT_HUB_PASS="$2"
         MQTT_APP_PASS="$3"
         MQTT_PASSWD_FILE="$4"
         MQTT_ACL_FILE="$5"
         MQTT_BROKER_USER="$6"
         for fn in mqtt_acl write_broker_files; do
           prog="/^$fn() {/,/^}/p"
           eval "$(sed -n "$prog" "$1")"
         done
         write_broker_files`,
        'bash',
        path.join(repoRoot, 'deploy', 'install.sh'),
        options.hubPassword,
        options.appPassword,
        m.passwd,
        m.acl,
        options.brokerUser ?? brokerAccount().name,
      ],
      {
        env: { ...process.env, PATH: `${path.dirname(options.passwdTool)}:${process.env.PATH ?? ''}` },
        stdio: 'ignore',
      },
    );
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? -1;
  }
}

/**
 * Run the real script, as the path unit would, and return its exit status.
 *
 * `--no-reload` unless a test names a broker to tell (`GETHOME_MQTT_BROKER_PID`):
 * without one the script would go looking for a mosquitto on the machine the
 * suite runs on, and a developer's own broker is not this suite's to signal.
 */
export function runAccountsScript(
  m: BrokerMachine,
  args: string[] = [],
  env: Record<string, string> = {},
): number {
  const reload = env.GETHOME_MQTT_BROKER_PID !== undefined;
  try {
    execFileSync('bash', [MQTT_ACCOUNTS_SCRIPT, '--quiet', ...(reload ? [] : ['--no-reload']), ...args], {
      env: scriptEnv(m, env),
      stdio: 'ignore',
    });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? -1;
  }
}

/**
 * Stand in for `gethome-mqtt-accounts.path`: run the script whenever the hub
 * writes a request it has not seen, until stopped. Asynchronous, so a route
 * can be waiting on the answer while the script produces it.
 */
export function watchForAccountRequests(
  m: BrokerMachine,
  env: Record<string, string> = {},
): () => void {
  const request = path.join(m.data, 'mqtt-accounts', 'request');
  const reload = env.GETHOME_MQTT_BROKER_PID !== undefined;
  let running = false;
  let seen = '';
  const timer = setInterval(() => {
    if (running || !existsSync(request)) return;
    let asked = '';
    try {
      asked = readFileSync(request, 'utf8');
    } catch {
      return;
    }
    if (asked === seen) return;
    seen = asked;
    running = true;
    execFile(
      'bash',
      [MQTT_ACCOUNTS_SCRIPT, '--quiet', ...(reload ? [] : ['--no-reload'])],
      { env: scriptEnv(m, env) },
      () => {
        running = false;
      },
    );
  }, 20);
  return () => clearInterval(timer);
}

/** The usernames the password file holds, in order. */
export function passwdUsers(m: BrokerMachine): string[] {
  return readFileSync(m.passwd, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.slice(0, line.indexOf(':')));
}

/** What the script said about its last run, as `key=value` pairs. */
export function accountsResult(m: BrokerMachine): Record<string, string> {
  const file = path.join(m.data, 'mqtt-accounts', 'result');
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
}
