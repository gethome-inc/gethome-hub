import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { MqttAdapter } from '../src/adapters/mqtt/adapter.js';
import { HeartbeatWatch, readHeartbeat } from '../src/adapters/mqtt/heartbeat.js';
import type { AdapterBus } from '../src/adapters/adapter.js';

/**
 * A device's heartbeat: what marks it offline when its last will was lost —
 * a broker that restarted from its saved copy, still holding the device's
 * retained `online`, while the device was switched off. Driven directly, with
 * a clock the test moves; the broker half (retained versus live, over a real
 * broker) is `integration/mqtt-roundtrip.test.ts`'s.
 */

describe('reading a heartbeat', () => {
  it('takes a whole number of seconds, held to 10 s – 1 h, and an empty payload withdraws it', () => {
    expect(readHeartbeat('60')).toBe(60);
    expect(readHeartbeat(' 30\n')).toBe(30);
    expect(readHeartbeat('5')).toBe(10);
    expect(readHeartbeat('86400')).toBe(3600);
    expect(readHeartbeat('')).toBe('withdrawn');
    expect(readHeartbeat('  ')).toBe('withdrawn');
    for (const refused of ['60.5', '-5', 'sixty', '{"every":60}', '1e3', '9999999']) {
      expect(readHeartbeat(refused), refused).toBeNull();
    }
  });
});

describe('HeartbeatWatch', () => {
  const clock = () => {
    let now = 1_000_000;
    return { now: () => now, advance: (ms: number) => (now += ms) };
  };

  it('calls a device quiet after two and a half intervals of silence, once', () => {
    const c = clock();
    const watch = new HeartbeatWatch(c.now);
    watch.declare('lamp', 60, false);
    c.advance(149_000);
    expect(watch.sweep()).toEqual([]);
    c.advance(2_000);
    expect(watch.sweep()).toEqual(['lamp']);
    c.advance(60_000);
    expect(watch.sweep()).toEqual([]);
  });

  it('never sooner than thirty seconds, whatever the interval', () => {
    const c = clock();
    const watch = new HeartbeatWatch(c.now);
    watch.declare('fast', 10, true);
    c.advance(29_000);
    expect(watch.sweep()).toEqual([]);
    c.advance(2_000);
    expect(watch.sweep()).toEqual(['fast']);
  });

  it('counts only what arrives live, and says when a quiet device comes back', () => {
    const c = clock();
    const watch = new HeartbeatWatch(c.now);
    watch.declare('lamp', 60, true);
    c.advance(100_000);
    expect(watch.heardFrom('lamp', false)).toBe(false); // a retained copy proves nothing
    c.advance(60_000);
    expect(watch.sweep()).toEqual(['lamp']);
    expect(watch.heardFrom('lamp', true)).toBe(true);
    expect(watch.heardFrom('lamp', true)).toBe(false);
    c.advance(100_000);
    expect(watch.sweep()).toEqual([]);
  });

  it('judges nothing that never said how often it speaks', () => {
    const c = clock();
    const watch = new HeartbeatWatch(c.now);
    expect(watch.heardFrom('old-board', true)).toBe(false);
    c.advance(3_600_000);
    expect(watch.sweep()).toEqual([]);
  });

  it("doesn't report a device its will already took offline, and forgets one that withdrew", () => {
    const c = clock();
    const watch = new HeartbeatWatch(c.now);
    watch.declare('lamp', 60, true);
    watch.declare('pump', 60, true);
    watch.wentOffline('lamp');
    watch.forget('pump');
    c.advance(600_000);
    expect(watch.sweep()).toEqual([]);
  });

  it('gives every device its whole allowance again when the broker connection starts again', () => {
    const c = clock();
    const watch = new HeartbeatWatch(c.now);
    watch.declare('lamp', 60, true);
    c.advance(151_000);
    expect(watch.sweep()).toEqual(['lamp']);
    watch.restart();
    c.advance(149_000);
    expect(watch.sweep()).toEqual([]);
    c.advance(2_000);
    expect(watch.sweep()).toEqual(['lamp']);
  });
});

/** The adapter with a fake bus and broker, and a clock the test moves. */
function harness() {
  let now = 1_000_000;
  const reachability: Array<{ deviceId: string; reachable: boolean }> = [];
  const bus: AdapterBus = {
    deviceUpserted: () => {},
    deviceRemoved: () => {},
    stateChanged: () => {},
    reachabilityChanged: (_adapter, deviceId, reachable) => reachability.push({ deviceId, reachable }),
    radioReachabilityChanged: () => {},
    commandFailed: () => {},
    activity: () => {},
  };
  const adapter = new MqttAdapter({ mqttUrl: 'mqtt://unused', log: pino({ level: 'silent' }), now: () => now });
  const published: Array<{ topic: string; payload: string }> = [];
  Object.assign(adapter as unknown as { bus: AdapterBus; client: unknown }, {
    bus,
    client: {
      publishAsync: async (topic: string, payload: string) => {
        published.push({ topic, payload });
      },
    },
  });
  const internals = adapter as unknown as {
    handleMessage(topic: string, payload: string, retained?: boolean): void;
    sweepQuiet(): void;
  };
  const message = (topic: string, payload: unknown, retained = false) =>
    internals.handleMessage(topic, typeof payload === 'string' ? payload : JSON.stringify(payload), retained);
  return {
    adapter,
    reachability,
    published,
    message,
    sweep: () => internals.sweepQuiet(),
    advance: (ms: number) => (now += ms),
  };
}

const discovery = {
  name: 'Motion LED',
  vendor: 'DIY',
  model: 'ESP32-S3',
  endpoints: [{ endpointId: 1, deviceKind: 'light', capabilities: ['onOff'], primary: 'onOff' }],
};

describe('MQTT heartbeats', () => {
  it('marks a device offline when the broker still says online but the device has gone quiet', () => {
    // A hub starting after its broker restarted: everything arrives retained.
    const h = harness();
    h.message('gethome/discovery/motion-led/config', discovery, true);
    h.message('gethome/device/motion-led/availability', 'online', true);
    h.message('gethome/device/motion-led/heartbeat', '60', true);
    expect(h.reachability.at(-1)).toEqual({ deviceId: 'motion-led', reachable: true });

    h.advance(149_000);
    h.sweep();
    expect(h.reachability.at(-1)!.reachable).toBe(true);
    h.advance(2_000);
    h.sweep();
    expect(h.reachability.at(-1)).toEqual({ deviceId: 'motion-led', reachable: false });

    // Switched on again: anything it publishes live brings it back.
    h.message('gethome/device/motion-led/heartbeat', '60');
    expect(h.reachability.at(-1)).toEqual({ deviceId: 'motion-led', reachable: true });
  });

  it('keeps a device that is speaking online, whatever it publishes', () => {
    const h = harness();
    h.message('gethome/discovery/motion-led/config', discovery);
    h.message('gethome/device/motion-led/availability', 'online');
    h.message('gethome/device/motion-led/heartbeat', '60');
    for (let minute = 0; minute < 10; minute += 1) {
      h.advance(60_000);
      h.message(minute % 2 ? 'gethome/device/motion-led/heartbeat' : 'gethome/device/motion-led/state', minute % 2 ? '60' : { onOff: true });
      h.sweep();
    }
    expect(h.reachability.every((entry) => entry.reachable)).toBe(true);
  });

  it('leaves a device without a heartbeat to its will, as before', () => {
    const h = harness();
    h.message('gethome/discovery/old-board/config', discovery, true);
    h.message('gethome/device/old-board/availability', 'online', true);
    h.advance(24 * 3_600_000);
    h.sweep();
    expect(h.reachability).toEqual([{ deviceId: 'old-board', reachable: true }]);
  });

  it('remembers a heartbeat that arrives before the device is met, and stops for one withdrawn', () => {
    const h = harness();
    h.message('gethome/device/motion-led/heartbeat', '60', true);
    h.message('gethome/discovery/motion-led/config', discovery, true);
    h.advance(151_000);
    h.sweep();
    expect(h.reachability.at(-1)).toEqual({ deviceId: 'motion-led', reachable: false });

    const w = harness();
    w.message('gethome/discovery/motion-led/config', discovery);
    w.message('gethome/device/motion-led/heartbeat', '60');
    w.message('gethome/device/motion-led/heartbeat', '');
    w.advance(600_000);
    w.sweep();
    expect(w.reachability).toEqual([]);
  });

  it('clears the heartbeat topic when the device is deleted in an app', async () => {
    const h = harness();
    h.message('gethome/discovery/motion-led/config', discovery);
    h.message('gethome/device/motion-led/heartbeat', '60');
    await h.adapter.forget('motion-led');
    expect(h.published).toContainEqual({ topic: 'gethome/device/motion-led/heartbeat', payload: '' });
    h.advance(600_000);
    h.sweep();
    expect(h.reachability).toEqual([]);
  });
});
