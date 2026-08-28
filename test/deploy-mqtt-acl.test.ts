import { spawn, type ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
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
  const clients: mqtt.MqttClient[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gethome-acl-'));
    port = await freePort();

    const substitutions: Record<string, string> = {
      '${MQTT_PASSWD_FILE}': path.join(dir, 'gethome.passwd'),
      '${MQTT_ACL_FILE}': path.join(dir, 'gethome.acl'),
      '${MQTT_ENV}': '/etc/gethome/mqtt.env',
      '${MQTT_HUB_USER}': 'gethome-hub',
      '${MQTT_APP_USER}': 'gethome',
    };
    const substitute = (text: string): string =>
      Object.entries(substitutions).reduce((acc, [from, to]) => acc.split(from).join(to), text);

    writeFileSync(path.join(dir, 'gethome.acl'), `${substitute(heredoc('MOSQACL'))}\n`);
    execFileSync(passwdTool!, ['-c', '-b', path.join(dir, 'gethome.passwd'), 'gethome-hub', HUB_PASSWORD]);
    execFileSync(passwdTool!, ['-b', path.join(dir, 'gethome.passwd'), 'gethome', APP_PASSWORD]);
    writeFileSync(
      path.join(dir, 'mosquitto.conf'),
      // No persistence: mosquitto drops privileges when it is started as root,
      // and a spool directory it cannot write to is a broker that will not
      // start for a reason that has nothing to do with what is being tested.
      `${substitute(heredoc('MOSQ')).replace('listener 1883', `listener ${port} 127.0.0.1`)}\n`,
    );
    // Same reason: the files below are read *after* that drop, so on a machine
    // where this suite runs as root they have to be readable by another
    // account. On a Pi `install.sh` narrows them to root:mosquitto 0640, which
    // is checked by reading the installer in `deploy-config.test.ts`.
    chmodSync(dir, 0o755);
    for (const file of ['gethome.acl', 'gethome.passwd', 'mosquitto.conf']) {
      chmodSync(path.join(dir, file), 0o644);
    }

    process = spawn(broker!, ['-c', path.join(dir, 'mosquitto.conf')], { stdio: 'ignore' });
    expect(await listening(port), 'the test broker never came up').toBe(true);
  }, 30_000);

  afterAll(async () => {
    for (const client of clients) await client.endAsync(true).catch(() => undefined);
    process?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  /** `reconnectPeriod: 0` so a refusal rejects instead of retrying forever. */
  async function connect(username?: string, password?: string): Promise<mqtt.MqttClient> {
    const client = await mqtt.connectAsync(`mqtt://127.0.0.1:${port}`, {
      reconnectPeriod: 0,
      connectTimeout: 5000,
      // `exactOptionalPropertyTypes` again: `password: undefined` is not the
      // same as an absent one, and mqtt.js reads whether the key is there.
      ...(username !== undefined ? { username } : {}),
      ...(password !== undefined ? { password } : {}),
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
    const collect = (topic: string): void => {
      seen.push(topic);
    };
    watcher.on('message', collect);
    await publish();
    await new Promise((resolve) => setTimeout(resolve, 500));
    watcher.off('message', collect);
    return seen;
  }

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
});
