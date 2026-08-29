import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { hostFromRequest, mqttAccess, type MqttBrokerConfig } from '../src/core/mqtt-access.js';
import { brokerCredentials } from '../src/mqtt-auth.js';

const broker = (overrides: Partial<MqttBrokerConfig> = {}): MqttBrokerConfig => ({
  url: 'mqtt://127.0.0.1:1883',
  username: 'gethome-hub',
  password: 'hub-secret',
  integrationUsername: 'gethome',
  integrationPassword: 'integration-secret',
  publicHost: '',
  baseTopic: 'zigbee2mqtt',
  ...overrides,
});

describe('broker credentials in the environment', () => {
  /**
   * `mqtt.env` carries the password inside `MQTT_URL` as well as beside it,
   * because a build old enough to predate `MQTT_USERNAME` can only authenticate
   * through the URL — that is the rollback story. Lifting it out here is what
   * keeps the rest of the process working with one shape, and keeps the URL
   * that reaches a log line free of a password.
   */
  it('lifts credentials out of the broker URL', () => {
    const config = loadConfig({ MQTT_URL: 'mqtt://gethome-hub:s3cret@127.0.0.1:1883' });
    expect(config.MQTT_USERNAME).toBe('gethome-hub');
    expect(config.MQTT_PASSWORD).toBe('s3cret');
    expect(config.MQTT_URL).not.toContain('s3cret');
    expect(config.MQTT_URL).toBe('mqtt://127.0.0.1:1883');
  });

  it('lets an explicit username outrank one left in the URL', () => {
    // The installer maintains mqtt.env; a URL somebody forgot to clean out
    // must not quietly win over it.
    const config = loadConfig({
      MQTT_URL: 'mqtt://stale:old@127.0.0.1:1883',
      MQTT_USERNAME: 'gethome-hub',
      MQTT_PASSWORD: 'current',
    });
    expect(config.MQTT_USERNAME).toBe('gethome-hub');
    expect(config.MQTT_PASSWORD).toBe('current');
    expect(config.MQTT_URL).toBe('mqtt://127.0.0.1:1883');
  });

  it('decodes what a URL had to escape', () => {
    const config = loadConfig({ MQTT_URL: 'mqtt://user:a%2Fb%40c@127.0.0.1:1883' });
    expect(config.MQTT_PASSWORD).toBe('a/b@c');
  });

  it('leaves an anonymous hub anonymous', () => {
    // Every hub installed before the broker had passwords. Connecting without
    // credentials is correct there, not a fallback: its drop-in still says
    // `allow_anonymous true`, and refusing to talk to its own broker over a
    // missing password would take Zigbee down to make a point.
    const config = loadConfig({ MQTT_URL: 'mqtt://127.0.0.1:1883' });
    expect(config.MQTT_USERNAME).toBe('');
    expect(brokerCredentials({ username: config.MQTT_USERNAME, password: config.MQTT_PASSWORD }))
      .toEqual({});
  });

  it('does not choke on a URL it cannot parse', () => {
    // Rejecting it here would be a hub that will not boot; the client is what
    // gets to complain, and it says something about MQTT rather than about zod.
    expect(() => loadConfig({ MQTT_URL: 'not a url' })).not.toThrow();
  });
});

describe('what GET /settings/mqtt answers', () => {
  it('gives the limited account first, and only that one without the admin key', () => {
    const limited = mqttAccess({
      config: broker(),
      requestHost: '192.168.1.50',
      canUseIntegrations: true,
      canUseFullAccess: false,
    });
    expect(limited.accounts.map((account) => account.id)).toEqual(['integrations']);
    expect(limited.accounts[0]?.recommended).toBe(true);
    // It may publish only its own tree. This mirrors the ACL install.sh writes;
    // `test/deploy-mqtt-acl.test.ts` is what proves the broker agrees.
    expect(limited.accounts[0]?.publish).toEqual(['gethome/#']);
    expect(limited.accounts[0]?.subscribe).toContain('zigbee2mqtt/+');
    expect(limited.accounts[0]?.subscribe).not.toContain('zigbee2mqtt/#');
    expect(JSON.stringify(limited)).not.toContain('hub-secret');
  });

  it('adds the hub’s own account for a caller who may see it', () => {
    const full = mqttAccess({
      config: broker(),
      requestHost: '192.168.1.50',
      canUseIntegrations: true,
      canUseFullAccess: true,
    });
    expect(full.accounts.map((account) => account.id)).toEqual(['integrations', 'hub']);
    expect(full.accounts[1]?.recommended).toBe(false);
  });

  /**
   * A hub whose installer predates broker passwords. `requiresPassword: false`
   * is the only way an app can tell "you have no credentials because none
   * exist" from "you have none because your role withholds them" — absence
   * would read as the second, and the honest answer is the first.
   */
  it('says plainly when the broker has no password at all', () => {
    const open = mqttAccess({
      config: broker({ username: '', password: '', integrationUsername: '', integrationPassword: '' }),
      requestHost: '192.168.1.50',
      canUseIntegrations: true,
      canUseFullAccess: true,
    });
    expect(open.requiresPassword).toBe(false);
    expect(open.accounts).toEqual([]);
  });

  it('answers with the address the request arrived on, and the real port', () => {
    // The hub dials its broker over loopback and an ESP32 cannot follow it
    // there; a Pi with Wi-Fi and Ethernet has two addresses and no way to rank
    // them, while the one the app just used reaches this machine by
    // construction.
    expect(hostFromRequest('192.168.1.50:8420')).toBe('192.168.1.50');
    expect(hostFromRequest('myhome.local:8420')).toBe('myhome.local');
    expect(hostFromRequest('[fe80::1]:8420')).toBe('[fe80::1]');
    expect(hostFromRequest('myhome.local')).toBe('myhome.local');
    expect(hostFromRequest(undefined)).toBe('');

    const moved = mqttAccess({
      config: broker({ url: 'mqtt://127.0.0.1:2883', publicHost: 'broker.example' }),
      requestHost: '192.168.1.50',
      canUseIntegrations: true,
      canUseFullAccess: false,
    });
    expect(moved.host).toBe('broker.example');
    expect(moved.port).toBe(2883);
  });
});
