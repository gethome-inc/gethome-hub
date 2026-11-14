import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mqtt from 'mqtt';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MqttAdapter } from '../src/adapters/mqtt/adapter.js';
import type { AdapterBus } from '../src/adapters/adapter.js';
import type { EndpointState } from '../src/schema/index.js';
import { brokerCredentials } from '../src/mqtt-auth.js';
import { loadConfig } from '../src/config.js';
import { HubEventBus } from '../src/core/bus.js';
import { MqttDeviceAccounts } from '../src/core/mqtt-device-accounts.js';
import { members } from '../src/db/schema.js';
import { openTestDb, type TestDb } from './helpers/db.js';
import {
  brokerAccount,
  runAccountsScript,
  runInstallerBrokerFiles,
  watchForAccountRequests,
  type BrokerMachine,
} from './helpers/mqtt-accounts.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const installer = readFileSync(path.join(repoRoot, 'deploy', 'install.sh'), 'utf8');

const found = (candidates: string[]): string | undefined => candidates.find((c) => existsSync(c));
const broker = found(['/usr/sbin/mosquitto', '/usr/local/sbin/mosquitto', '/opt/homebrew/sbin/mosquitto']);
const passwdTool = found(['/usr/bin/mosquitto_passwd', '/usr/local/bin/mosquitto_passwd', '/opt/homebrew/bin/mosquitto_passwd']);

const HUB_PASSWORD = 'hub-side-secret';
const APP_PASSWORD = 'integration-side-secret';

function heredoc(delimiter: string): string {
  const match = installer.match(new RegExp(`<<'?${delimiter}'?\\n([\\s\\S]*?)\\n${delimiter}\\n`));
  if (!match) throw new Error(`heredoc ${delimiter} not found in install.sh`);
  return match[1]!;
}

/**
 * What mosquitto says, from 2.0.16 on, about a file it reads whose owner,
 * group or mode is not the one it wants — each line ending "Future versions
 * will refuse to load this file". The owner and group it wants are those of the
 * account it reads as, so that is whom both writers hand the files to.
 */
const OWNERSHIP_WARNING = /Warning: File .*(owner is not|group is not|world readable)|Future versions will refuse to load/;

async function eventually(label: string, check: () => boolean, ms = 5000): Promise<void> {
  for (const started = Date.now(); !check(); ) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function listening(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
    });
    if (open) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/**
 * **What the broker's own rules actually do, run against the broker.**
 *
 * Everything else about `deploy/` is checked by reading it, which is the best
 * that can be done for a shell script that only ever runs on a Pi. This one is
 * different: the whole security claim of the change — "a device you wire in
 * yourself can watch the home but cannot drive it" — is a property of an ACL
 * file interpreted by mosquitto, and reading four `topic read` lines proves
 * nothing about what mosquitto does with them.
 *
 * So this starts a real broker on the config `install.sh` writes and tries the
 * attacks. The client is the `mqtt` package the hub itself connects with, so
 * there is nothing extra to install: the gate is the broker binary being
 * present, exactly as in `deploy-config.test.ts`.
 */
describe.skipIf(!broker || !passwdTool)('the MQTT ACL install.sh writes', () => {
  let dir = '';
  let port = 0;
  let process: ChildProcess | undefined;
  // Everything the broker logged, from its start: it logs to stderr when its
  // config names nowhere else, as this one does not.
  let brokerLog = '';
  const ownershipWarnings = (): string[] =>
    brokerLog.split('\n').filter((line) => OWNERSHIP_WARNING.test(line));
  const clients: mqtt.MqttClient[] = [];
  // The hub's half of a device's own account, on this same broker: a real
  // table, the real service, and the real root script standing where the
  // path unit would start it.
  let machine: BrokerMachine;
  let store: TestDb | null = null;
  let events: HubEventBus;
  let accounts: MqttDeviceAccounts;
  let stopWatching: (() => void) | undefined;
  let anna: { id: string; name: string };

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gethome-acl-'));
    port = await freePort();
    // Where this suite runs as root, the broker drops to its own account
    // before it opens either of its files, exactly as a hub's does — so that
    // account has to be able to reach them through this directory.
    chmodSync(dir, 0o755);

    // What `install.sh` leaves for device accounts: the data directory the hub
    // writes its list into, and the file that says this machine applies it.
    const conf = path.join(dir, 'conf');
    const data = path.join(dir, 'data');
    mkdirSync(conf);
    mkdirSync(path.join(data, 'mqtt-accounts'), { recursive: true });
    writeFileSync(path.join(conf, 'hub.env'), `DATA_DIR=${data}\n`);
    writeFileSync(path.join(data, 'mqtt-accounts', 'enabled'), '');
    machine = {
      conf,
      data,
      etc: dir,
      passwd: path.join(dir, 'gethome.passwd'),
      acl: path.join(dir, 'gethome.acl'),
    };

    // The password file and the ACL, written by the installer's own code:
    // its accounts, its rules, and the owner and mode it gives them.
    expect(
      runInstallerBrokerFiles(machine, { passwdTool: passwdTool!, hubPassword: HUB_PASSWORD, appPassword: APP_PASSWORD }),
      'install.sh could not write the broker its files',
    ).toBe(0);

    const substitutions: Record<string, string> = {
      '${MQTT_PASSWD_FILE}': machine.passwd,
      '${MQTT_ACL_FILE}': machine.acl,
      '${MQTT_ENV}': '/etc/gethome/mqtt.env',
    };
    const substitute = (text: string): string =>
      Object.entries(substitutions).reduce((acc, [from, to]) => acc.split(from).join(to), text);
    writeFileSync(
      path.join(dir, 'mosquitto.conf'),
      // No persistence: mosquitto drops privileges when it is started as root,
      // and a spool directory it cannot write to is a broker that will not
      // start for a reason that has nothing to do with what is being tested.
      `${substitute(heredoc('MOSQ')).replace('listener 1883', `listener ${port} 127.0.0.1`)}\n`,
    );
    chmodSync(path.join(dir, 'mosquitto.conf'), 0o644);

    // Where AppArmor confines mosquitto to /etc/mosquitto — Ubuntu 26.04 ships
    // that profile — this broker cannot read a config from a temporary
    // directory and never listens. CI unloads the profile first (the Start
    // Mosquitto step in `.github/workflows/ci.yml`); a local run on such a
    // machine fails the same way until it is unloaded there too.
    process = spawn(broker!, ['-c', path.join(dir, 'mosquitto.conf')], { stdio: ['ignore', 'ignore', 'pipe'] });
    process.stderr!.setEncoding('utf8');
    process.stderr!.on('data', (chunk: string) => {
      brokerLog += chunk;
    });
    expect(await listening(port), `the test broker never came up:\n${brokerLog}`).toBe(true);
    store = await openTestDb();
    const [row] = await store!.db.insert(members).values({ name: 'Anna', role: 'owner' }).returning();
    anna = { id: row!.id, name: row!.name };
    events = new HubEventBus();
    accounts = new MqttDeviceAccounts({
      db: store!.db,
      dataDir: data,
      events,
      reserved: ['gethome-hub', 'gethome'],
      log: pino({ level: 'silent' }),
      applyWaitMs: 10_000,
      // No wait before the broker is told: what is being timed here is the
      // broker, and the wait has its own test beside the service.
      revokeSettleMs: 0,
    });
    // The script tells this broker to read its files again, the way
    // `systemctl reload mosquitto` tells the one on a hub.
    stopWatching = watchForAccountRequests(machine, { GETHOME_MQTT_BROKER_PID: String(process.pid) });
  }, 30_000);

  afterAll(async () => {
    stopWatching?.();
    accounts?.stop();
    for (const client of clients) await client.endAsync(true).catch(() => undefined);
    process?.kill();
    await store?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** `reconnectPeriod: 0` so a refusal rejects instead of retrying forever. */
  async function connect(
    username?: string,
    password?: string,
    clientId?: string,
  ): Promise<mqtt.MqttClient> {
    const client = await mqtt.connectAsync(`mqtt://127.0.0.1:${port}`, {
      reconnectPeriod: 0,
      connectTimeout: 5000,
      // `exactOptionalPropertyTypes` again: `password: undefined` is not the
      // same as an absent one, and mqtt.js reads whether the key is there.
      ...(username !== undefined ? { username } : {}),
      ...(password !== undefined ? { password } : {}),
      ...(clientId !== undefined ? { clientId } : {}),
    });
    clients.push(client);
    return client;
  }

  /** Publish each topic, then report which of them reached `watcher`. */
  async function delivered(
    watcher: mqtt.MqttClient,
    publish: () => Promise<void>,
  ): Promise<string[]> {
    const seen: string[] = [];
    // Only what was published while watching. A message the broker held as
    // retained is handed over on subscribing, with its retain flag set, and
    // says nothing about who may publish now — an earlier test's discovery
    // document would otherwise turn up in every wildcard subscription.
    const collect = (topic: string, _payload: Buffer, packet: { retain?: boolean }): void => {
      if (packet.retain !== true) seen.push(topic);
    };
    watcher.on('message', collect);
    await publish();
    await new Promise((resolve) => setTimeout(resolve, 500));
    watcher.off('message', collect);
    return seen;
  }

  /**
   * **Who owns the two files is something the broker has an opinion about.**
   * From 2.0.16 on, mosquitto checks the owner and group of its password file
   * and ACL against the account it reads them as, and says so at every start
   * and every reload — "owner is not mosquitto. Future versions will refuse to
   * load this file" — for the `root:mosquitto` 0640 the installer used to
   * write. No released broker refuses yet; one that does would be a hub whose
   * broker will not start after an `apt upgrade`. So the files are handed to
   * the broker's own account, and its log is where that is checked: this
   * broker reads exactly what `install.sh` wrote, as the account a hub's
   * reads it as (`brokerAccount`), and has to have nothing to say about it.
   */
  it('reads the files the installer writes without a word about who owns them', async () => {
    // The log is there to be read: once the broker says it is running, it has
    // opened both files and said whatever it had to say about them.
    await eventually('the broker to say it is running', () => /mosquitto version \S+ running/.test(brokerLog));
    expect(ownershipWarnings()).toEqual([]);
    const account = brokerAccount();
    for (const file of [machine.passwd, machine.acl]) {
      const stat = statSync(file);
      expect(stat.mode & 0o777, file).toBe(0o600);
      expect(stat.uid, file).toBe(account.uid);
      expect(stat.gid, file).toBe(account.gid);
    }
  });

  it('refuses an anonymous connection outright', async () => {
    // The whole point. Before this, anybody on the home Wi-Fi could open one
    // of these and publish `zigbee2mqtt/<device>/set`.
    await expect(connect()).rejects.toThrow();
  });

  it('refuses a wrong password', async () => {
    await expect(connect('gethome', 'not-the-password')).rejects.toThrow();
  });

  it('lets the hub’s own account do everything', async () => {
    const hub = await connect('gethome-hub', HUB_PASSWORD);
    await hub.subscribeAsync('#');
    const seen = await delivered(hub, async () => {
      await hub.publishAsync('zigbee2mqtt/lamp/set', '{"state":"OFF"}');
      await hub.publishAsync('zigbee2mqtt/bridge/request/permit_join', '{"time":254}');
      await hub.publishAsync('gethome/device/pump/state', '{"onOff":true}');
    });
    expect(seen).toContain('zigbee2mqtt/lamp/set');
    expect(seen).toContain('zigbee2mqtt/bridge/request/permit_join');
    expect(seen).toContain('gethome/device/pump/state');
    await hub.unsubscribeAsync('#');
  });

  /**
   * The attack this change exists to stop, from the account an owner is
   * actually handed. A denied publish is *silent* on the wire — MQTT gives the
   * publisher no error at QoS 0 — so the only honest way to ask is to watch
   * from the other side and see that nothing arrived.
   */
  it('will not let an integration control a Zigbee device or open the network', async () => {
    const hub = await connect('gethome-hub', HUB_PASSWORD);
    const integration = await connect('gethome', APP_PASSWORD);
    await hub.subscribeAsync('#');

    const seen = await delivered(hub, async () => {
      await integration.publishAsync('zigbee2mqtt/lamp/set', '{"state":"OFF"}');
      await integration.publishAsync('zigbee2mqtt/front-door-lock/set', '{"state":"UNLOCK"}');
      await integration.publishAsync('zigbee2mqtt/bridge/request/permit_join', '{"time":254}');
      await integration.publishAsync('zigbee2mqtt/bridge/request/device/remove', '{"id":"lamp"}');
      // Its own tree, which is the whole of what it is for.
      await integration.publishAsync('gethome/device/pump/state', '{"onOff":true}');
    });

    expect(seen).toEqual(['gethome/device/pump/state']);
    await hub.unsubscribeAsync('#');
  });

  /**
   * **The whole path, end to end, on the config a Pi really gets.**
   *
   * Everything above tests the broker. This tests the product: `loadConfig`
   * reading what `install.sh` writes into `mqtt.env`, the hub's own
   * `MqttAdapter` signing in with it, and a DIY device — connected with the
   * *limited* account, exactly as `docs/mqtt-integrations.md` tells an
   * integrator to — being adopted.
   *
   * That last part is the half most likely to be quietly wrong: an ACL tight
   * enough to stop an attack and too tight for the feature it protects would
   * pass every test above and ship a broken integrator story.
   */
  it('adopts a device published by an integration, over the hub\'s own adapter', async () => {
    const config = loadConfig({
      MQTT_URL: `mqtt://127.0.0.1:${port}`,
      MQTT_USERNAME: 'gethome-hub',
      MQTT_PASSWORD: HUB_PASSWORD,
    });
    expect(config.MQTT_USERNAME).toBe('gethome-hub');

    const adopted: string[] = [];
    const states: Array<Partial<EndpointState>> = [];
    const bus = {
      deviceUpserted: (descriptor: { externalId: string }) => adopted.push(descriptor.externalId),
      deviceRemoved: () => {},
      stateChanged: (
        _adapter: unknown,
        _externalId: string,
        _endpointId: number,
        patch: Partial<EndpointState>,
      ) => states.push(patch),
      reachabilityChanged: () => {},
      radioReachabilityChanged: () => {},
      commandFailed: () => {},
      activity: () => {},
    } as unknown as AdapterBus;

    const adapter = new MqttAdapter({
      mqttUrl: config.MQTT_URL,
      // The same two lines `src/index.ts` builds. `brokerCredentials` takes the
      // wire shape rather than the config's SCREAMING_CASE, which is what
      // stopped this from being written as `brokerCredentials(config)` and
      // silently connecting anonymously.
      ...brokerCredentials({ username: config.MQTT_USERNAME, password: config.MQTT_PASSWORD }),
      log: pino({ level: 'silent' }),
    });
    await adapter.start(bus);

    // The integrator's side, with the account an owner is handed.
    const board = await connect('gethome', APP_PASSWORD);
    await board.publishAsync(
      'gethome/discovery/pool-pump/config',
      JSON.stringify({
        name: 'Pool pump',
        endpoints: [
          { endpointId: 1, deviceKind: 'outlet', capabilities: ['onOff'], primary: 'onOff' },
        ],
      }),
      { retain: true },
    );
    await board.publishAsync('gethome/device/pool-pump/state', JSON.stringify({ onOff: true }));
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(adopted).toContain('pool-pump');
    expect(states.at(-1)).toMatchObject({ onOff: true });

    // And the hub can still drive it, which is the direction the ACL leaves
    // to the hub alone: the board may not write to zigbee2mqtt/, but the hub
    // writing to gethome/ is what makes the pump switchable from an app.
    const heard: string[] = [];
    await board.subscribeAsync('gethome/device/pool-pump/set');
    board.on('message', (topic) => heard.push(topic));
    await adapter.execute('pool-pump', 1, { type: 'power', on: false });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(heard).toContain('gethome/device/pool-pump/set');

    await adapter.stop();
  }, 20_000);

  /**
   * The other half, and the reason the account is worth having: it can watch.
   * A board that reacts to a motion sensor needs the sensor's reports, and
   * nothing in `bridge/info` — which carries Zigbee2MQTT's own configuration,
   * and we are not going to depend on upstream redacting the network key.
   */
  it('lets an integration read device state and the lifecycle, but not bridge/info', async () => {
    const hub = await connect('gethome-hub', HUB_PASSWORD);
    const integration = await connect('gethome', APP_PASSWORD);
    // A wildcard covering everything, so what arrives is the broker's choice
    // rather than a subscription written to match the answer.
    await integration.subscribeAsync('#');

    const seen = await delivered(integration, async () => {
      for (const topic of [
        'zigbee2mqtt/motion-sensor',
        'zigbee2mqtt/bridge/state',
        'zigbee2mqtt/bridge/event',
        'zigbee2mqtt/bridge/devices',
        'zigbee2mqtt/bridge/info',
        'zigbee2mqtt/bridge/logging',
        'gethome/device/pump/state',
      ]) {
        await hub.publishAsync(topic, `payload for ${topic}`);
      }
    });

    expect(seen).toContain('zigbee2mqtt/motion-sensor');
    expect(seen).toContain('zigbee2mqtt/bridge/state');
    expect(seen).toContain('zigbee2mqtt/bridge/event');
    expect(seen).toContain('zigbee2mqtt/bridge/devices');
    expect(seen).toContain('gethome/device/pump/state');
    expect(seen).not.toContain('zigbee2mqtt/bridge/info');
    expect(seen).not.toContain('zigbee2mqtt/bridge/logging');
    await integration.unsubscribeAsync('#');
  });

  /**
   * **A device that holds an account of its own.**
   *
   * The claim is the roadmap's, and it is the broker's to keep: a board is
   * confined to its own topics, and deleting it ends its account — the live
   * connection included. Both are properties of two files as mosquitto reads
   * them, so both are asked of mosquitto: the hub's own service mints the
   * account, the real `deploy/mqtt-accounts.sh` writes the files and has this
   * broker read them again, and a client then tries what a board that had
   * been lost, resold or flashed by somebody else would try.
   *
   * A device signs in with its id as its client id as well as its username,
   * which is what a device on the convention ordinarily does.
   */
  describe('a device with an account of its own', () => {
    /** Mint an account the way the route does, and hand back its password. */
    async function account(deviceId: string, projectKey?: string): Promise<string> {
      const outcome = await accounts.mint({ deviceId, projectKey, member: anna });
      if (!outcome.ok) throw new Error(`the hub refused ${deviceId}: ${outcome.reason}`);
      expect(outcome.state, 'the broker never took the new list').toBe('applied');
      return outcome.password;
    }

    /** Resolves once the broker has hung up on `client`. */
    function hungUp(client: mqtt.MqttClient): Promise<void> {
      return new Promise((resolve) => {
        if (!client.connected) resolve();
        else client.once('close', () => resolve());
      });
    }

    async function within<T>(label: string, promise: Promise<T>, ms = 5000): Promise<T> {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
      });
      try {
        return await Promise.race([promise, late]);
      } finally {
        clearTimeout(timer);
      }
    }

    it('signs in with a password the hub hashed itself, and is adopted', async () => {
      // The hub never hands root a password: it writes the line mosquitto's
      // password file holds. This is where that line meets a real broker.
      const password = await account('desk-light-x7k2q9');

      const adopted: string[] = [];
      const bus = {
        deviceUpserted: (descriptor: { externalId: string }) => adopted.push(descriptor.externalId),
        deviceRemoved: () => {},
        stateChanged: () => {},
        reachabilityChanged: () => {},
        radioReachabilityChanged: () => {},
        commandFailed: () => {},
        activity: () => {},
      } as unknown as AdapterBus;
      const adapter = new MqttAdapter({
        mqttUrl: `mqtt://127.0.0.1:${port}`,
        ...brokerCredentials({ username: 'gethome-hub', password: HUB_PASSWORD }),
        log: pino({ level: 'silent' }),
      });
      await adapter.start(bus);

      const board = await connect('desk-light-x7k2q9', password, 'desk-light-x7k2q9');
      const heard: string[] = [];
      await board.subscribeAsync('gethome/device/desk-light-x7k2q9/set');
      await board.subscribeAsync('gethome/discovery/desk-light-x7k2q9/config');
      board.on('message', (topic) => heard.push(topic));
      await board.publishAsync(
        'gethome/discovery/desk-light-x7k2q9/config',
        JSON.stringify({
          name: 'Desk light',
          endpoints: [{ endpointId: 1, deviceKind: 'light', capabilities: ['onOff'], primary: 'onOff' }],
        }),
        { retain: true },
      );
      await board.publishAsync('gethome/device/desk-light-x7k2q9/availability', 'online', { retain: true });
      await board.publishAsync('gethome/device/desk-light-x7k2q9/state', JSON.stringify({ onOff: true }));
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(adopted).toContain('desk-light-x7k2q9');

      // The hub can still work it, and it hears its own config topic — which
      // is how it learns it was deleted.
      await adapter.execute('desk-light-x7k2q9', 1, { type: 'power', on: false });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(heard).toContain('gethome/device/desk-light-x7k2q9/set');
      expect(heard).toContain('gethome/discovery/desk-light-x7k2q9/config');

      await adapter.stop();
      // Leave nothing retained for the tests after this one.
      const hub = await connect('gethome-hub', HUB_PASSWORD);
      await hub.publishAsync('gethome/discovery/desk-light-x7k2q9/config', '', { retain: true });
      await hub.publishAsync('gethome/device/desk-light-x7k2q9/availability', '', { retain: true });
    }, 20_000);

    it('cannot write anywhere but its own topics', async () => {
      const password = await account('desk-light-x7k2q9');
      await account('porch-cam-aa11bb');
      const hub = await connect('gethome-hub', HUB_PASSWORD);
      const board = await connect('desk-light-x7k2q9', password, 'desk-light-x7k2q9');
      await hub.subscribeAsync('#');

      const own = [
        'gethome/discovery/desk-light-x7k2q9/config',
        'gethome/device/desk-light-x7k2q9/state',
        'gethome/device/desk-light-x7k2q9/state/2',
        'gethome/device/desk-light-x7k2q9/availability',
        'gethome/device/desk-light-x7k2q9/heartbeat',
        'gethome/device/desk-light-x7k2q9/camera',
        'gethome/device/desk-light-x7k2q9/log',
      ];
      const seen = await delivered(hub, async () => {
        for (const topic of own) await board.publishAsync(topic, 'x');
        for (const topic of [
          // Another device: its state, its discovery document, its commands.
          'gethome/device/porch-cam-aa11bb/state',
          'gethome/discovery/porch-cam-aa11bb/config',
          'gethome/device/porch-cam-aa11bb/set',
          // A device nobody has made yet — which the shared account could
          // announce into the home.
          'gethome/discovery/invented/config',
          // A name that only begins like its own.
          'gethome/device/desk-light-x7k2q9x/state',
          'gethome/device/desk-light/state',
          // The rest of the tree, and the home.
          'gethome/project/9f3a11c2/frames',
          'gethome/anything',
          'zigbee2mqtt/lamp/set',
          'zigbee2mqtt/front-door-lock/set',
          'zigbee2mqtt/bridge/request/permit_join',
        ]) {
          await board.publishAsync(topic, 'x');
        }
      });

      expect(seen.sort()).toEqual([...own].sort());
      await hub.unsubscribeAsync('#');
    });

    it('cannot read anywhere but its own topics', async () => {
      const password = await account('desk-light-x7k2q9');
      const hub = await connect('gethome-hub', HUB_PASSWORD);
      const board = await connect('desk-light-x7k2q9', password, 'desk-light-x7k2q9');
      // A wildcard covering everything, so what arrives is the broker's
      // choice rather than a subscription written to match the answer.
      await board.subscribeAsync('#');

      const seen = await delivered(board, async () => {
        for (const topic of [
          'gethome/device/desk-light-x7k2q9/set',
          'gethome/discovery/desk-light-x7k2q9/config',
          'gethome/device/porch-cam-aa11bb/set',
          'gethome/device/porch-cam-aa11bb/state',
          'gethome/device/porch-cam-aa11bb/camera',
          'gethome/discovery/porch-cam-aa11bb/config',
          'gethome/project/9f3a11c2/frames',
          // What the shared account may watch, and this one may not: it is a
          // board's account, not an integration's.
          'zigbee2mqtt/motion-sensor',
          'zigbee2mqtt/bridge/devices',
          'zigbee2mqtt/bridge/info',
        ]) {
          await hub.publishAsync(topic, `payload for ${topic}`);
        }
      });

      expect(seen.sort()).toEqual([
        'gethome/device/desk-light-x7k2q9/set',
        'gethome/discovery/desk-light-x7k2q9/config',
      ]);
      await board.unsubscribeAsync('#');
    });

    it('reaches its own project’s topics and no other project’s', async () => {
      const reader = await account('plate-reader-cd34ef', '9f3a11c2');
      const other = await account('door-bell-gh56ij', '0b0b0b0b');
      const none = await account('desk-light-x7k2q9');
      const hub = await connect('gethome-hub', HUB_PASSWORD);
      // A service opens a connection of its own for these, under a client id
      // that is not its device id — the device library holds that one.
      const part = await connect('plate-reader-cd34ef', reader, 'plate-reader-cd34ef-project');
      const stranger = await connect('door-bell-gh56ij', other, 'door-bell-gh56ij');
      const loner = await connect('desk-light-x7k2q9', none, 'desk-light-x7k2q9');
      await hub.subscribeAsync('#');
      await part.subscribeAsync('#');

      const written = await delivered(hub, async () => {
        await part.publishAsync('gethome/project/9f3a11c2/frames', 'mine');
        await part.publishAsync('gethome/project/0b0b0b0b/ring', 'not mine');
        await stranger.publishAsync('gethome/project/9f3a11c2/frames', 'not theirs');
        await loner.publishAsync('gethome/project/9f3a11c2/frames', 'no project at all');
      });
      // One arrival, and it is the part's own.
      expect(written).toEqual(['gethome/project/9f3a11c2/frames']);

      const read = await delivered(part, async () => {
        await hub.publishAsync('gethome/project/9f3a11c2/answer', 'for the part');
        await hub.publishAsync('gethome/project/0b0b0b0b/ring', 'for the other project');
      });
      expect(read).toEqual(['gethome/project/9f3a11c2/answer']);
      await hub.unsubscribeAsync('#');
      await part.unsubscribeAsync('#');
    });

    it('cannot pass for another device by signing in under its client id', async () => {
      // The ACL substitutes the name a client *signed in* with. A client id is
      // whatever the client says it is, so nothing may hang on it.
      const password = await account('desk-light-x7k2q9');
      await account('porch-cam-aa11bb');
      const hub = await connect('gethome-hub', HUB_PASSWORD);
      const impostor = await connect('desk-light-x7k2q9', password, 'porch-cam-aa11bb');
      await hub.subscribeAsync('#');
      const seen = await delivered(hub, async () => {
        await impostor.publishAsync('gethome/device/porch-cam-aa11bb/state', '{"onOff":true}');
        await impostor.publishAsync('gethome/discovery/porch-cam-aa11bb/config', '');
      });
      expect(seen).toEqual([]);
      await hub.unsubscribeAsync('#');
    });

    it('is cut off the moment its device is removed, and cannot come back', async () => {
      const password = await account('desk-light-x7k2q9');
      const kept = await account('porch-cam-aa11bb');
      const hub = await connect('gethome-hub', HUB_PASSWORD);
      const integration = await connect('gethome', APP_PASSWORD);
      const board = await connect('desk-light-x7k2q9', password, 'desk-light-x7k2q9');
      const neighbour = await connect('porch-cam-aa11bb', kept, 'porch-cam-aa11bb');

      // The registry's own event, as it emits it when a device leaves the
      // home — deleted in an app, or withdrawn by the device itself.
      const gone = hungUp(board);
      events.emit('deviceRemoved', 'hub-device-id', { adapter: 'mqtt', externalId: 'desk-light-x7k2q9' });
      await within('the broker to hang up on the removed device', gone);

      // The board that was switched off while it was deleted, switched on
      // again: this is the one that used to come straight back.
      await expect(connect('desk-light-x7k2q9', password, 'desk-light-x7k2q9')).rejects.toThrow();

      // Nobody else was disturbed by the broker reading its files again.
      expect(hub.connected).toBe(true);
      expect(integration.connected).toBe(true);
      expect(neighbour.connected).toBe(true);
      await hub.subscribeAsync('gethome/device/porch-cam-aa11bb/state');
      const seen = await delivered(hub, async () => {
        await neighbour.publishAsync('gethome/device/porch-cam-aa11bb/state', '{"onOff":true}');
      });
      expect(seen).toEqual(['gethome/device/porch-cam-aa11bb/state']);
    }, 20_000);

    it('ends the old password when the device is set up again', async () => {
      const first = await account('desk-light-x7k2q9');
      const board = await connect('desk-light-x7k2q9', first, 'desk-light-x7k2q9');
      const gone = hungUp(board);

      const second = await account('desk-light-x7k2q9');
      expect(second).not.toBe(first);
      await within('the broker to hang up on the old password', gone);
      await expect(connect('desk-light-x7k2q9', first, 'desk-light-x7k2q9')).rejects.toThrow();
      const again = await connect('desk-light-x7k2q9', second, 'desk-light-x7k2q9');
      expect(again.connected).toBe(true);
    }, 20_000);

    it('keeps its account when the installer writes both files afresh', async () => {
      // An update is `install.sh` again: the password file begins again with
      // the broker's own two accounts and the ACL is written whole, and then
      // the broker is restarted. The script runs in between, from the hub's
      // list — or every board in the home would be refused after an update.
      const password = await account('plate-reader-cd34ef', '9f3a11c2');
      // And the pair it replaces is one an older build left, whose owner and
      // mode the new files must not inherit: `root:mosquitto` 0640 where this
      // suite can make it, and readable by everyone where it cannot — which
      // the broker warns about too.
      for (const file of [machine.passwd, machine.acl]) {
        if (userInfo().uid === 0) {
          chownSync(file, 0, brokerAccount().gid);
          chmodSync(file, 0o640);
        } else {
          chmodSync(file, 0o644);
        }
      }
      expect(
        runInstallerBrokerFiles(machine, { passwdTool: passwdTool!, hubPassword: HUB_PASSWORD, appPassword: APP_PASSWORD }),
      ).toBe(0);
      expect(readFileSync(machine.passwd, 'utf8')).not.toContain('plate-reader-cd34ef');
      for (const file of [machine.passwd, machine.acl]) {
        expect(statSync(file).mode & 0o777, file).toBe(0o600);
        expect(statSync(file).uid, file).toBe(brokerAccount().uid);
      }

      expect(runAccountsScript(machine, ['--no-reload'])).toBe(0);
      // Stands in for the installer's restart: the broker reads what is there.
      process!.kill('SIGHUP');
      await new Promise((resolve) => setTimeout(resolve, 500));

      const hub = await connect('gethome-hub', HUB_PASSWORD);
      const part = await connect('plate-reader-cd34ef', password, 'plate-reader-cd34ef');
      await hub.subscribeAsync('gethome/#');
      const seen = await delivered(hub, async () => {
        await part.publishAsync('gethome/device/plate-reader-cd34ef/state', '{}');
        await part.publishAsync('gethome/project/9f3a11c2/frames', 'x');
      });
      expect(seen.sort()).toEqual([
        'gethome/device/plate-reader-cd34ef/state',
        'gethome/project/9f3a11c2/frames',
      ]);
      await hub.unsubscribeAsync('gethome/#');
    }, 20_000);

    it('leaves the shared account exactly what it was', async () => {
      // Boards already in homes hold it, and nobody is going to flash them
      // again: after everything above, it still owns `gethome/` and can
      // still only watch Zigbee.
      const hub = await connect('gethome-hub', HUB_PASSWORD);
      const integration = await connect('gethome', APP_PASSWORD);
      await hub.subscribeAsync('#');
      const seen = await delivered(hub, async () => {
        await integration.publishAsync('gethome/discovery/pool-pump/config', '');
        await integration.publishAsync('gethome/device/pool-pump/state', '{"onOff":true}');
        await integration.publishAsync('gethome/project/9f3a11c2/frames', 'x');
        await integration.publishAsync('zigbee2mqtt/lamp/set', '{"state":"OFF"}');
      });
      expect(seen.sort()).toEqual([
        'gethome/device/pool-pump/state',
        'gethome/discovery/pool-pump/config',
        'gethome/project/9f3a11c2/frames',
      ]);
      await hub.unsubscribeAsync('#');
    });
  });

  /**
   * Last, because everything above has had the broker read its files again:
   * every device account was applied by the real script, which rewrites both
   * files and sends this broker a SIGHUP, and the installer wrote them afresh
   * once more. A reload checks the files as a start does, so the log has to
   * be as quiet now as it was then.
   *
   * And it has to be able to speak, or its silence proves nothing: a file the
   * broker would complain about — here, one anybody could read — has to make
   * this same log say so. A broker older than 2.0.16 has no such check, and
   * there this half has nothing to show.
   */
  it('has nothing to say about who owns them after every reload, and says so when it should', async () => {
    expect(brokerLog, 'the broker was never asked to read its files again').toMatch(/Reloading config/);
    expect(ownershipWarnings()).toEqual([]);

    const version = /mosquitto version (\d+)\.(\d+)\.(\d+) running/.exec(brokerLog);
    expect(version, 'the broker never said which it is').not.toBeNull();
    const [major, minor, patch] = version!.slice(1).map(Number) as [number, number, number];
    if (major * 1_000_000 + minor * 1_000 + patch < 2_000_016) return;

    chmodSync(machine.passwd, 0o644);
    try {
      process!.kill('SIGHUP');
      await eventually('the broker to warn about a file anybody can read', () => ownershipWarnings().length > 0);
      expect(ownershipWarnings().join('\n')).toMatch(/gethome\.passwd has world readable permissions/);
    } finally {
      chmodSync(machine.passwd, 0o600);
    }
  });
});
