import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  // A broker started as root drops to its own account before it opens either
  // file, so on a machine where the suite is root they have to be reachable by
  // another account. The script narrows what it rewrites to 0640 and, as root,
  // hands it to the broker's group — which is the thing being tested.
  chmodSync(etc, 0o755);
  chmodSync(passwd, 0o644);
  chmodSync(acl, 0o644);
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
    ...env,
  };
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
