import { describe, expect, it } from 'vitest';
import { parseWriteFailure } from '../src/adapters/zigbee/write-failures.js';

/**
 * A `set` that did not land, read out of Zigbee2MQTT's `bridge/logging`.
 *
 * The excerpts below are real, taken off a hub whose owner set a detection
 * interval on an Aqara motion sensor from the GetHome app and watched the
 * value come back a minute later — which is the whole reason this parser
 * exists. Nothing else in the system can tell "queued for a sleeping device"
 * apart from "refused".
 */

/** Verbatim, from a Pi with an Aqara `0x54ef4410006387bc` asleep on the network. */
const SUPERSEDED =
  `z2m: Publish 'set' 'detection_interval' to '0x54ef4410006387bc' failed: ` +
  `'Error: ZCL command 0x54ef4410006387bc/1 manuSpecificLumi.write({"258":{"value":[9],"type":32}}, ` +
  `{"timeout":10000,"disableResponse":false,"disableRecovery":false,"disableDefaultResponse":true,` +
  `"direction":0,"reservedBits":0,"manufacturerCode":4447,"writeUndiv":false}) failed (Request superseded)'`;

const NO_RESPONSE =
  `z2m: Publish 'set' 'detection_interval' to 'Hallway motion' failed: ` +
  `'Error: ZCL command 0x54ef4410006387bc/1 manuSpecificLumi.write(...) failed ` +
  `(Device did not respond to attribute write)'`;

const REFUSED =
  `z2m: Publish 'set' 'child_lock' to 'Kitchen plug' failed: ` +
  `'Error: Value 'maybe' is not allowed'`;

describe('reading a failed Zigbee set out of the bridge log', () => {
  it('names the device and the property that was being written', () => {
    const failure = parseWriteFailure(SUPERSEDED);
    expect(failure?.name).toBe('0x54ef4410006387bc');
    expect(failure?.property).toBe('detection_interval');
  });

  it('calls a superseded write what it is — not a failure', () => {
    // A newer write to the same property replaced this one in the queue, so
    // the value the user asked for is still on its way. Reporting it as a
    // failure would put four errors on screen for one correct outcome.
    expect(parseWriteFailure(SUPERSEDED)?.kind).toBe('superseded');
  });

  it('does not let the ZCL dump inside a supersede error read as a timeout', () => {
    // The supersede message carries the whole command, `"timeout":10000`
    // included. Classifying on the generic phrase first would swallow the one
    // outcome that must not be reported.
    expect(SUPERSEDED).toContain('"timeout":10000');
    expect(parseWriteFailure(SUPERSEDED)?.kind).not.toBe('unreachable');
  });

  it('separates a device that never answered from one that said no', () => {
    expect(parseWriteFailure(NO_RESPONSE)?.kind).toBe('unreachable');
    expect(parseWriteFailure(REFUSED)?.kind).toBe('refused');
  });

  it('keeps Z2M’s own words, so an app can show them rather than paraphrase', () => {
    expect(parseWriteFailure(REFUSED)?.detail).toContain("Value 'maybe' is not allowed");
  });

  it('reads a friendly name with spaces in it', () => {
    expect(parseWriteFailure(NO_RESPONSE)?.name).toBe('Hallway motion');
  });

  it('is silent on every other line the bridge logs', () => {
    // An unrecognised line yields nothing — the `diagnosis.ts` rule. A wrong
    // diagnosis is worse than the silence the caller already has.
    for (const line of [
      'z2m: Connected to MQTT server',
      "z2m: Device '0x54ef4410006387bc' joined",
      "z2m: Publish 'get' 'state' to 'Kitchen plug' failed: 'Error: nope'",
      "z2m: Received MQTT message on 'zigbee2mqtt/Kitchen plug/set'",
      '',
    ]) {
      expect(parseWriteFailure(line)).toBeNull();
    }
  });
});
