import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { MqttAdapter } from '../src/adapters/mqtt/adapter.js';
import { MAX_PROGRAM_HOST_LENGTH, readProgram, sameProgram } from '../src/adapters/mqtt/program.js';
import type { AdapterBus, AdapterDeviceDescriptor } from '../src/adapters/adapter.js';

/**
 * A device that says it is a program — a script, a bridge or a service on a
 * computer rather than a board — on its own retained topic, because a key in
 * the discovery document would be refused whole by every hub from before this.
 * Driven directly, like the camera and heartbeat halves beside it: a fake bus
 * records what the registry would hear and a fake client what the broker
 * would be sent. Over a real broker it is `integration/mqtt-roundtrip.test.ts`'s
 * (HUB_TEST_MQTT=1), and the wire it reaches an app on is `api.test.ts`'s.
 */

describe('reading a program payload', () => {
  it('takes a JSON object, with the computer’s name or without it', () => {
    expect(readProgram('{"host":"nuc.local"}')).toEqual({ host: 'nuc.local' });
    expect(readProgram('{}')).toEqual({});
    expect(readProgram(' {"host":"  Living room Mac  "}\n')).toEqual({ host: 'Living room Mac' });
    // A name that is only spaces is a name not given: still a program.
    expect(readProgram('{"host":"   "}')).toEqual({});
    expect(readProgram('{"host":""}')).toEqual({});
  });

  it('passes over keys it does not know, and keeps none of them', () => {
    expect(readProgram('{"host":"nuc.local","runtime":"python","pid":4121,"more":{"deep":[1]}}')).toEqual({
      host: 'nuc.local',
    });
    expect(readProgram('{"runtime":"python"}')).toEqual({});
  });

  it('cuts a name that is too long, and never through a character', () => {
    expect(readProgram(JSON.stringify({ host: 'n'.repeat(300) }))).toEqual({
      host: 'n'.repeat(MAX_PROGRAM_HOST_LENGTH),
    });
    // The 120th unit would be the first half of a two-unit character.
    expect(readProgram(JSON.stringify({ host: `${'n'.repeat(119)}🖥 desk` }))).toEqual({ host: 'n'.repeat(119) });
    // And a cut that lands after a space leaves no space behind.
    expect(readProgram(JSON.stringify({ host: `${'n'.repeat(119)} mac` }))).toEqual({ host: 'n'.repeat(119) });
    // Exactly at the limit is untouched.
    expect(readProgram(JSON.stringify({ host: 'n'.repeat(120) }))).toEqual({ host: 'n'.repeat(120) });
  });

  it('reads an empty payload as taking it back', () => {
    expect(readProgram('')).toBe('withdrawn');
    expect(readProgram('  \n')).toBe('withdrawn');
  });

  it('refuses what is not a JSON object, and a name that is not text', () => {
    for (const refused of [
      'nonsense',
      '{"host":"nuc.local"',
      '"nuc.local"',
      '42',
      'true',
      'null',
      '[]',
      '[{"host":"nuc.local"}]',
      '{"host":7}',
      '{"host":null}',
      '{"host":["nuc.local"]}',
      '{"host":{"name":"nuc.local"}}',
    ]) {
      expect(readProgram(refused), refused).toBeNull();
    }
  });

  it('knows a program saying the same thing again from one saying something new', () => {
    expect(sameProgram({ host: 'nuc.local' }, { host: 'nuc.local' })).toBe(true);
    expect(sameProgram({}, {})).toBe(true);
    expect(sameProgram({ host: 'nuc.local' }, { host: 'attic-pi' })).toBe(false);
    expect(sameProgram({ host: 'nuc.local' }, {})).toBe(false);
  });
});

/** The adapter with a fake bus and broker, a log the test can read, and a clock it moves. */
function harness() {
  let now = 1_000_000;
  const upserted: AdapterDeviceDescriptor[] = [];
  const removed: string[] = [];
  const reachability: Array<{ deviceId: string; reachable: boolean }> = [];
  const bus: AdapterBus = {
    deviceUpserted: (descriptor) => upserted.push(descriptor),
    deviceRemoved: (_adapter, externalId) => removed.push(externalId),
    stateChanged: () => {},
    reachabilityChanged: (_adapter, deviceId, reachable) => reachability.push({ deviceId, reachable }),
    radioReachabilityChanged: () => {},
    commandFailed: () => {},
    activity: () => {},
  };
  const warnings: Array<{ deviceId?: string; msg: string }> = [];
  const log = pino({ level: 'warn' }, { write: (line: string) => warnings.push(JSON.parse(line)) });
  const adapter = new MqttAdapter({ mqttUrl: 'mqtt://unused', log, now: () => now });
  const published: Array<{ topic: string; payload: string; options?: unknown }> = [];
  Object.assign(adapter as unknown as { bus: AdapterBus; client: unknown }, {
    bus,
    client: {
      publishAsync: async (topic: string, payload: string, options?: unknown) => {
        published.push({ topic, payload, ...(options !== undefined ? { options } : {}) });
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
    upserted,
    removed,
    reachability,
    warnings,
    published,
    message,
    sweep: () => internals.sweepQuiet(),
    advance: (ms: number) => (now += ms),
  };
}

const discovery = {
  name: 'Tide table',
  vendor: 'DIY',
  model: 'tides.py',
  endpoints: [{ endpointId: 1, deviceKind: 'sensor', capabilities: ['custom'], primary: 'custom' }],
};

const CONFIG = 'gethome/discovery/tide-table/config';
const PROGRAM = 'gethome/device/tide-table/program';

describe('MQTT programs', () => {
  it('announces a device as a program once it says so, and as plain hardware until then', () => {
    const h = harness();
    h.message(CONFIG, discovery);
    expect(h.upserted).toHaveLength(1);
    // Absent, not empty or null: a board's descriptor is what it always was.
    expect(h.upserted[0]).not.toHaveProperty('program');

    h.message(PROGRAM, { host: 'nuc.local' });
    expect(h.upserted).toHaveLength(2);
    expect(h.upserted[1]).toMatchObject({ adapter: 'mqtt', externalId: 'tide-table', suggestedName: 'Tide table' });
    expect(h.upserted[1]!.program).toEqual({ host: 'nuc.local' });
    expect(h.warnings).toEqual([]);
  });

  it('keeps what a program said before its discovery document arrived', () => {
    // Retained messages come back in whatever order the broker holds them.
    const h = harness();
    h.message(PROGRAM, { host: 'nuc.local' }, true);
    expect(h.upserted).toHaveLength(0);
    h.message(CONFIG, discovery, true);
    // Met as a program from its first announcement, with no second one needed.
    expect(h.upserted).toHaveLength(1);
    expect(h.upserted[0]!.program).toEqual({ host: 'nuc.local' });
  });

  it('is a program on a computer it did not name when it says only that', () => {
    const h = harness();
    h.message(CONFIG, discovery);
    h.message(PROGRAM, {});
    expect(h.upserted.at(-1)!.program).toEqual({});
  });

  it('hands the registry only what the hub reads, whatever else the device said', () => {
    const h = harness();
    h.message(CONFIG, discovery);
    h.message(PROGRAM, { host: 'nuc.local', runtime: 'python', token: 'not-for-anyone' });
    expect(h.upserted.at(-1)!.program).toEqual({ host: 'nuc.local' });
    expect(JSON.stringify(h.upserted)).not.toContain('not-for-anyone');
    expect(h.warnings).toEqual([]);
  });

  it('keeps it when the device announces itself again', () => {
    const h = harness();
    h.message(CONFIG, discovery);
    h.message(PROGRAM, { host: 'nuc.local' });
    h.message(CONFIG, { ...discovery, model: 'tides.py 2' });
    expect(h.upserted.at(-1)).toMatchObject({ model: 'tides.py 2', program: { host: 'nuc.local' } });
  });

  it('announces a move to another computer, and nothing when a program repeats itself', () => {
    const h = harness();
    h.message(CONFIG, discovery);
    h.message(PROGRAM, { host: 'nuc.local' });
    const before = h.upserted.length;
    // What a program publishes on every connection, and what the broker hands
    // back on every reconnect: no announcement, so no write and no frame.
    h.message(PROGRAM, { host: 'nuc.local' });
    h.message(PROGRAM, { host: ' nuc.local ', runtime: 'python' }, true);
    expect(h.upserted).toHaveLength(before);

    h.message(PROGRAM, { host: 'attic-pi' });
    expect(h.upserted).toHaveLength(before + 1);
    expect(h.upserted.at(-1)!.program).toEqual({ host: 'attic-pi' });
    // Dropping the name is a change too.
    h.message(PROGRAM, {});
    expect(h.upserted).toHaveLength(before + 2);
    expect(h.upserted.at(-1)!.program).toEqual({});
  });

  it('makes the device hardware again on an empty payload', () => {
    const h = harness();
    h.message(CONFIG, discovery);
    h.message(PROGRAM, { host: 'nuc.local' });
    h.message(PROGRAM, '');
    expect(h.upserted.at(-1)).not.toHaveProperty('program');
    expect(h.removed).toEqual([]);

    // Taking back what was never said changes nothing.
    const before = h.upserted.length;
    h.message(PROGRAM, '');
    expect(h.upserted).toHaveLength(before);

    // And one taken back before the device was met leaves nothing waiting for it.
    const early = harness();
    early.message(PROGRAM, { host: 'nuc.local' }, true);
    early.message(PROGRAM, '');
    early.message(CONFIG, discovery);
    expect(early.upserted.at(-1)).not.toHaveProperty('program');
  });

  it('ignores a payload it cannot read, with a warning — the device is neither rejected nor removed', async () => {
    const h = harness();
    h.message(CONFIG, discovery);
    h.message(PROGRAM, { host: 'nuc.local' });
    const before = h.upserted.length;

    const bad = ['nonsense', '"nuc.local"', '[]', '42', 'null', '{"host":7}', '{"host":null}'];
    for (const payload of bad) h.message(PROGRAM, payload);

    expect(h.warnings).toHaveLength(bad.length);
    expect(h.warnings.every((line) => line.deviceId === 'tide-table' && /program announcement/.test(line.msg))).toBe(true);
    // Nothing was announced, nothing removed, and what it said before stands.
    expect(h.upserted).toHaveLength(before);
    expect(h.removed).toEqual([]);
    h.message(CONFIG, discovery);
    expect(h.upserted.at(-1)!.program).toEqual({ host: 'nuc.local' });
    // Still a device the hub sends commands to.
    await h.adapter.execute('tide-table', 1, { type: 'toggle' });
    expect(h.published.at(-1)).toMatchObject({ topic: 'gethome/device/tide-table/set' });

    // A bad payload from a device that never said anything leaves it hardware.
    const plain = harness();
    plain.message(CONFIG, discovery);
    plain.message(PROGRAM, '{"host":7}');
    expect(plain.upserted).toHaveLength(1);
    expect(plain.upserted[0]).not.toHaveProperty('program');
    expect(plain.removed).toEqual([]);
  });

  it('counts as the device speaking, like anything else on its own topics', () => {
    const h = harness();
    h.message(CONFIG, discovery);
    h.message('gethome/device/tide-table/availability', 'online');
    h.message('gethome/device/tide-table/heartbeat', '60');
    h.advance(151_000);
    h.sweep();
    expect(h.reachability.at(-1)).toEqual({ deviceId: 'tide-table', reachable: false });

    // The broker's own copy proves nothing; the program saying it live does.
    h.message(PROGRAM, { host: 'nuc.local' }, true);
    expect(h.reachability.at(-1)!.reachable).toBe(false);
    h.message(PROGRAM, { host: 'nuc.local' });
    expect(h.reachability.at(-1)).toEqual({ deviceId: 'tide-table', reachable: true });
  });

  it('forgets it when the device removes itself', () => {
    const h = harness();
    h.message(CONFIG, discovery);
    h.message(PROGRAM, { host: 'nuc.local' });
    h.message(CONFIG, '');
    expect(h.removed).toEqual(['tide-table']);
    // Back later without saying so again: a new device, and hardware.
    h.message(CONFIG, discovery);
    expect(h.upserted.at(-1)).not.toHaveProperty('program');
  });

  it('clears the program topic when the device is deleted in an app, and its own echo changes nothing', async () => {
    const h = harness();
    h.message(CONFIG, discovery);
    h.message(PROGRAM, { host: 'nuc.local' });
    await h.adapter.forget('tide-table');
    expect(h.published).toContainEqual({ topic: PROGRAM, payload: '', options: { qos: 1, retain: true } });

    // The broker hands our own empty messages back on the subscription.
    const before = h.upserted.length;
    h.message(PROGRAM, '');
    h.message(CONFIG, '');
    expect(h.upserted).toHaveLength(before);
    expect(h.removed).toEqual([]);
    expect(h.warnings).toEqual([]);

    // A board that never said it was a program has the topic cleared all the
    // same: the hub may not have been running when it last said so.
    const plain = harness();
    plain.message(CONFIG, discovery);
    await plain.adapter.forget('tide-table');
    expect(plain.published.map((entry) => entry.topic)).toContain(PROGRAM);

    // Set up again afterwards, it is whatever it says it is then.
    h.message(CONFIG, discovery);
    expect(h.upserted.at(-1)).not.toHaveProperty('program');
  });

  it('keeps only so many for devices it has not met, and never turns away one it has', () => {
    const h = harness();
    for (let index = 0; index < 80; index += 1) {
      h.message(`gethome/device/stranger-${index}/program`, { host: 'somewhere' }, true);
    }
    h.message('gethome/discovery/stranger-0/config', discovery);
    expect(h.upserted.at(-1)!.program).toEqual({ host: 'somewhere' });
    // One that arrived after the room ran out was not kept …
    h.message('gethome/discovery/stranger-79/config', discovery);
    expect(h.upserted.at(-1)).toMatchObject({ externalId: 'stranger-79' });
    expect(h.upserted.at(-1)).not.toHaveProperty('program');
    // … and is taken at its word the moment it says so as a device the hub knows.
    h.message('gethome/device/stranger-79/program', { host: 'somewhere' });
    expect(h.upserted.at(-1)).toMatchObject({ externalId: 'stranger-79', program: { host: 'somewhere' } });
  });
});
