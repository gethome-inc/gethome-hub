import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyZigbeeLog, readZigbeeProblem } from '../src/adapters/zigbee/diagnosis.js';

/**
 * Why the Zigbee radio isn't running, read out of Zigbee2MQTT's own log.
 *
 * `zigbee.connected: false` is a fact with several very different causes, and
 * the cause used to live only in a log on the Pi — where the person who needs
 * it, looking at an app on another machine, cannot reach it.
 *
 * The excerpts below are real, taken off a hub that hit each one.
 */

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gethome-z2m-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Verbatim from a Zero 2 W with a factory-fresh SONOFF ZBDongle-E. */
const FIRMWARE_TOO_OLD = `
[2026-08-09 01:40:04] info: zh:adapter:discovery: Matched adapter=ember path=/dev/ttyACM0, score=4
[2026-08-09 01:40:06] info: zh:ember:ezsp: ======== EZSP started ========
[2026-08-09 01:40:06] error: z2m: Error while starting zigbee-herdsman
[2026-08-09 01:40:06] error: z2m: Failed to start zigbee-herdsman
[2026-08-09 01:40:06] error: z2m: Error: Adapter EZSP protocol version (8) is not supported by Host [13-19].
`;

describe('classifying Zigbee2MQTT failures', () => {
  it('names a coordinator whose firmware is behind, and both versions', () => {
    const problem = classifyZigbeeLog(FIRMWARE_TOO_OLD);
    expect(problem?.kind).toBe('firmware-too-old');
    // The versions are the whole point: "too old" without them is unactionable.
    expect(problem?.summary).toContain('v8');
    expect(problem?.summary).toContain('v13');
    expect(problem?.detail).toContain('EZSP protocol version (8)');
  });

  it('prefers the specific cause over the generic one that follows it', () => {
    // Every one of these failures also logs "Failed to start zigbee-herdsman".
    // Reporting that instead would be true and useless.
    expect(classifyZigbeeLog(FIRMWARE_TOO_OLD)?.kind).not.toBe('radio-unreachable');
  });

  it('names a stick Zigbee2MQTT could not place', () => {
    const problem = classifyZigbeeLog(
      'error: z2m: Error: USB adapter discovery error (No valid USB adapter found).',
    );
    expect(problem?.kind).toBe('adapter-unidentified');
  });

  it('names the onboarding wizard, in case it ever comes back', () => {
    expect(classifyZigbeeLog('Onboarding page is available at http://0.0.0.0:8080/')?.kind)
      .toBe('onboarding-pending');
  });

  it('falls back to "the radio did not answer" rather than inventing a reason', () => {
    expect(classifyZigbeeLog('error: z2m: Failed to start zigbee-herdsman')?.kind)
      .toBe('radio-unreachable');
  });

  it('says nothing at all about a log it does not recognise', () => {
    // A wrong diagnosis is worse than `connected: false`, which the caller has
    // already been told.
    expect(classifyZigbeeLog('info: z2m: Connected to MQTT server')).toBeUndefined();
    expect(classifyZigbeeLog('')).toBeUndefined();
  });
});

describe('reading it off disk', () => {
  it('reads the newest run, not the first one', () => {
    const data = tmp();
    for (const [run, body] of [
      ['2026-08-01.10-00-00', 'error: z2m: Failed to start zigbee-herdsman'],
      ['2026-08-09.01-40-03', FIRMWARE_TOO_OLD],
    ] as const) {
      mkdirSync(path.join(data, 'log', run), { recursive: true });
      writeFileSync(path.join(data, 'log', run, 'log.log'), body);
    }
    expect(readZigbeeProblem(data)?.kind).toBe('firmware-too-old');
  });

  it('reads the tail of a log too big to hold, and still finds the failure', () => {
    // These files grow without bound on a busy network, and this runs behind
    // `GET /hub` — which is public and is the installer's health check. The
    // padding here is an order of magnitude past the 64 KiB window, so a
    // read-it-all-then-slice implementation would pass this test while a
    // multi-megabyte log on a 512 MB board would not be fine.
    const data = tmp();
    const run = path.join(data, 'log', '2026-08-09.01-40-03');
    mkdirSync(run, { recursive: true });
    const padding = `[2026-08-09 01:39:00] info: z2m: MQTT publish: topic 'zigbee2mqtt/x'\n`;
    writeFileSync(path.join(run, 'log.log'), padding.repeat(10_000) + FIRMWARE_TOO_OLD);
    expect(readZigbeeProblem(data)?.kind).toBe('firmware-too-old');
  });

  it('says nothing when the failure has scrolled out of the window', () => {
    // The alternative is reporting a cause from a run that has since recovered.
    const data = tmp();
    const run = path.join(data, 'log', '2026-08-09.01-40-03');
    mkdirSync(run, { recursive: true });
    const padding = `[2026-08-09 01:39:00] info: z2m: MQTT publish: topic 'zigbee2mqtt/x'\n`;
    writeFileSync(path.join(run, 'log.log'), FIRMWARE_TOO_OLD + padding.repeat(10_000));
    expect(readZigbeeProblem(data)).toBeUndefined();
  });

  it('is silent when there is no Zigbee2MQTT to read', () => {
    // Every one of these is an ordinary state — no coordinator ever plugged in,
    // a hub that has never started Z2M — and none may become an API error.
    expect(readZigbeeProblem(tmp())).toBeUndefined();
    expect(readZigbeeProblem('/nonexistent/nowhere')).toBeUndefined();
  });
});
