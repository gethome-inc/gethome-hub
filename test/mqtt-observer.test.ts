import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { MqttObserver, type MqttFrame } from '../src/core/mqtt-observer.js';

const log = pino({ level: 'silent' });

function observer(base = 'zigbee2mqtt') {
  const seen: MqttFrame[] = [];
  const instance = new MqttObserver({
    // Never connected in these tests — `ingest` is the seam.
    mqttUrl: 'mqtt://127.0.0.1:1883',
    z2mBaseTopic: base,
    log,
    onFrame: (frame) => seen.push(frame),
  });
  return { instance, seen };
}

const payload = (text: string) => Buffer.from(text, 'utf8');

describe('MqttObserver', () => {
  it('sorts topics into the channels the apps group by', () => {
    const { instance, seen } = observer();
    instance.ingest('zigbee2mqtt/kitchen lamp', payload('{}'));
    instance.ingest('zigbee2mqtt/bridge/info', payload('{}'));
    instance.ingest('zigbee2mqtt/bridge/logging', payload('{}'));
    instance.ingest('gethome/device/boiler/state', payload('{}'));
    instance.ingest('homeassistant/status', payload('online'));

    expect(seen.map((frame) => frame.channel)).toEqual([
      'zigbee-device',
      'zigbee-bridge',
      'zigbee-bridge',
      'gethome',
      'other',
    ]);
  });

  it('follows a renamed base topic rather than the literal "zigbee2mqtt"', () => {
    const { instance, seen } = observer('zb');
    instance.ingest('zb/porch sensor', payload('{}'));
    instance.ingest('zigbee2mqtt/porch sensor', payload('{}'));

    expect(seen.map((frame) => frame.channel)).toEqual(['zigbee-device', 'other']);
  });

  it('reads direction off the topic, so the hub\'s own writes are marked', () => {
    const { instance, seen } = observer();
    instance.ingest('zigbee2mqtt/kitchen lamp', payload('{}'));
    instance.ingest('zigbee2mqtt/kitchen lamp/set', payload('{}'));
    instance.ingest('zigbee2mqtt/kitchen lamp/get', payload('{}'));
    instance.ingest('zigbee2mqtt/bridge/request/permit_join', payload('{}'));
    instance.ingest('gethome/device/boiler/set/2', payload('{}'));

    expect(seen.map((frame) => frame.direction)).toEqual(['in', 'out', 'out', 'out', 'out']);
  });

  it('truncates a huge payload and says that it did', () => {
    const { instance, seen } = observer();
    instance.ingest('zigbee2mqtt/bridge/devices', payload('x'.repeat(10_000)));

    const frame = seen[0]!;
    expect(frame.truncated).toBe(true);
    expect(frame.payload.length).toBe(2048);
  });

  it('leaves an ordinary payload whole', () => {
    const { instance, seen } = observer();
    instance.ingest('zigbee2mqtt/kitchen lamp', payload('{"state":"ON"}'));

    expect(seen[0]!.truncated).toBe(false);
    expect(seen[0]!.payload).toBe('{"state":"ON"}');
  });

  it('numbers frames so a client can key rows on the sequence', () => {
    const { instance, seen } = observer();
    for (let index = 0; index < 5; index += 1) {
      instance.ingest('zigbee2mqtt/lamp', payload('{}'));
    }

    expect(seen.map((frame) => frame.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps the buffer to a bounded number of frames', () => {
    const { instance } = observer();
    for (let index = 0; index < 500; index += 1) {
      instance.ingest('zigbee2mqtt/lamp', payload(`{"n":${index}}`));
    }

    const recent = instance.recent();
    expect(recent).toHaveLength(300);
    // The tail, not the head: what somebody opening the inspector wants is
    // what just happened.
    expect(recent[recent.length - 1]!.payload).toBe('{"n":499}');
  });

  it('bounds the buffer in bytes too, so a few huge frames cannot hold megabytes', () => {
    const { instance } = observer();
    // 200 frames is well under the frame cap; at 2 KB each they are not under
    // the byte cap, which is the limit that has to bite here.
    for (let index = 0; index < 200; index += 1) {
      instance.ingest('zigbee2mqtt/bridge/devices', payload('x'.repeat(4000)));
    }

    const recent = instance.recent();
    expect(recent.length).toBeLessThan(200);
    const bytes = recent.reduce((total, frame) => total + frame.payload.length + frame.topic.length, 0);
    expect(bytes).toBeLessThanOrEqual(256 * 1024);
  });

  it('hands back only the tail asked for', () => {
    const { instance } = observer();
    for (let index = 0; index < 20; index += 1) {
      instance.ingest('zigbee2mqtt/lamp', payload(`{"n":${index}}`));
    }

    const recent = instance.recent(5);
    expect(recent).toHaveLength(5);
    expect(recent[0]!.payload).toBe('{"n":15}');
  });

  it('counts watchers, so the tap outlives one client but not all of them', async () => {
    const { instance } = observer();
    expect(instance.watching).toBe(false);

    instance.attach();
    instance.attach();
    expect(instance.watching).toBe(true);

    instance.detach();
    expect(instance.watching).toBe(true);

    instance.detach();
    expect(instance.watching).toBe(false);

    await instance.stop();
  });

  it('forgets the buffer once it is torn down', async () => {
    const { instance } = observer();
    instance.ingest('zigbee2mqtt/lamp', payload('{}'));
    expect(instance.recent()).toHaveLength(1);

    await instance.stop();
    expect(instance.recent()).toHaveLength(0);
  });
});
