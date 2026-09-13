import { describe, expect, it } from 'vitest';
import {
  discoveryCapabilitiesFor,
  InvalidSetupCodeError,
  needsBluetooth,
  parseSetupCode,
} from '../src/adapters/matter/setup-code.js';
import { classifyCommissionError } from '../src/adapters/matter/commission-failures.js';

/**
 * The bug this file is about: the hub decided *where to look* for an accessory
 * without reading the one field that answers it.
 *
 * A factory-new — or factory-reset — Wi-Fi accessory has no network to be on,
 * so its QR payload says BLE and not `onIpNetwork`. The adapter hardcoded
 * `{ onIpNetwork: true }` for every code, searched the LAN, found nothing, and
 * (matter.js applying no timeout when none is passed) never stopped: the app
 * read "Pairing with your hub" for as long as anybody left it open.
 */
describe('reading a Matter setup code', () => {
  // The spec's own example payload (core § 5.1.4.1): passcode 20202021,
  // discriminator 3840, vendor 0xFFF1, product 0x8000, BLE-only.
  const bleOnlyQr = 'MT:Y.K9042C00KA0648G00';

  it('reads a QR payload', () => {
    const code = parseSetupCode(bleOnlyQr);
    expect(code.passcode).toBe(20_202_021);
    expect(code.longDiscriminator).toBe(3840);
    expect(code.shortDiscriminator).toBeUndefined();
  });

  it('reads what the accessory says about where it can be found', () => {
    // The whole point. This one is BLE and nothing else, which is what a
    // device that has never joined a network must say.
    expect(parseSetupCode(bleOnlyQr).capabilities).toEqual({
      ble: true,
      onIpNetwork: false,
      wifiPublicActionFrame: false,
      nfc: false,
    });
  });

  it('reads a manual code, and does not invent capabilities for it', () => {
    // Eleven digits carry a passcode and four bits of discriminator. They do
    // not carry discovery capabilities, and `undefined` here is load-bearing:
    // "the code did not say" has to be answered by looking everywhere, not by
    // guessing one answer and searching half the places.
    const code = parseSetupCode('34970112332');
    expect(code.passcode).toBe(20_202_021);
    expect(code.shortDiscriminator).toBe(15);
    expect(code.longDiscriminator).toBeUndefined();
    expect(code.capabilities).toBeUndefined();
  });

  it('ignores the grouping somebody typed', () => {
    expect(parseSetupCode('3497-011-2332')).toEqual(parseSetupCode('34970112332'));
  });

  it('refuses a code that is not one, rather than starting a search', () => {
    // The app's own field caps the length; this is the hub's half. A wrong
    // checksum is a mistyped code, and telling somebody so now beats three
    // minutes of a spinner ending in "not found".
    expect(() => parseSetupCode('12345678')).toThrow(InvalidSetupCodeError);
    expect(() => parseSetupCode('34970112333')).toThrow(InvalidSetupCodeError);
    expect(() => parseSetupCode('MT:NONSENSE')).toThrow(InvalidSetupCodeError);
  });
});

describe('deciding where to look', () => {
  const bleOnly = parseSetupCode('MT:Y.K9042C00KA0648G00');
  const manual = parseSetupCode('34970112332');

  it('follows a QR that says Bluetooth, on a hub that has it', () => {
    expect(discoveryCapabilitiesFor(bleOnly, { ble: true })).toEqual({
      ble: true,
      onIpNetwork: false,
    });
  });

  it('looks everywhere for a code that said nothing', () => {
    expect(discoveryCapabilitiesFor(manual, { ble: true })).toEqual({
      ble: true,
      onIpNetwork: true,
    });
    expect(discoveryCapabilitiesFor(manual, { ble: false })).toEqual({
      ble: false,
      onIpNetwork: true,
    });
  });

  it('still looks on the network when the hub has no Bluetooth', () => {
    // The accessory may have been commissioned elsewhere since its label was
    // printed and be sitting on the LAN under multi-admin. Refusing outright
    // would fail a pairing that would have worked.
    expect(discoveryCapabilitiesFor(bleOnly, { ble: false })).toEqual({
      ble: false,
      onIpNetwork: true,
    });
  });

  it('names the one case worth refusing before searching', () => {
    // A hub with Bluetooth has nothing to refuse; a hub without it, holding a
    // code that says Bluetooth only, has an answer that cannot change while
    // somebody waits for it.
    expect(needsBluetooth(bleOnly, { ble: false })).toBe(true);
    expect(needsBluetooth(bleOnly, { ble: true })).toBe(false);
    expect(needsBluetooth(manual, { ble: false })).toBe(false);
  });
});

describe('naming why a pairing failed', () => {
  it('turns matter.js\'s own words into something to do', () => {
    const failure = classifyCommissionError(
      new Error('discovery of node with discriminator 1938 failed: No commissionable device was discovered'),
    );
    expect(failure.kind).toBe('not-found');
    expect(failure.summary).toContain('pairing mode');
    // The library's sentence survives as the disclosure, because somebody
    // debugging a hub still needs it.
    expect(failure.detail).toContain('discriminator 1938');
  });

  it('puts the specific reason ahead of the discovery failure wrapped round it', () => {
    // Most-specific-first, and load-bearing rather than tidy: an accessory
    // that refuses the passcode also produces a discovery that commissioned
    // nothing, and a generic match placed first swallows the only outcome
    // that tells somebody to check what they typed.
    expect(
      classifyCommissionError(
        new Error('discovery failed: PASE error, invalid passcode for the device'),
      ).kind,
    ).toBe('wrong-code');
    expect(
      classifyCommissionError(
        new Error('No device could be commissioned: device is already commissioned to another fabric'),
      ).kind,
    ).toBe('already-paired');
  });

  it('falls back rather than guessing', () => {
    const failure = classifyCommissionError(new Error('the kettle exploded'));
    expect(failure.kind).toBe('failed');
    expect(failure.detail).toBe('the kettle exploded');
  });
});
