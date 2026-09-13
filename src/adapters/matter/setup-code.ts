import { ManualPairingCodeCodec, QrPairingCodeCodec } from '@matter/main/types';

/**
 * What a Matter setup code actually tells the hub.
 *
 * There are two forms and they carry different amounts of truth. A **QR
 * payload** (`MT:…`) is the full onboarding payload: the passcode, a 12-bit
 * discriminator, the vendor and product ids, and — the field this module
 * exists for — the accessory's own `discoveryCapabilities`, which says where
 * it can be *found*. A **manual code** is eleven digits (or twenty-one when
 * it carries the vendor/product ids too) squeezed down to a passcode and a
 * 4-bit *short* discriminator, and says nothing about discovery at all.
 *
 * That difference is why this is its own module rather than four lines in the
 * adapter. The adapter used to hardcode `{ onIpNetwork: true }` for both
 * forms, which is a claim about the accessory that the accessory itself had
 * already contradicted: a factory-new or factory-reset Wi-Fi accessory has no
 * network to be on, so its QR says **BLE and nothing else**. Searching the IP
 * network for it finds nothing, for as long as anybody is willing to wait.
 */
export interface SetupCode {
  passcode: number;
  /** From a QR: the full 12-bit discriminator. */
  longDiscriminator?: number;
  /** From a manual code: the top 4 bits of it, which is all that fits. */
  shortDiscriminator?: number;
  /**
   * Where the accessory says it can be found, from a QR payload.
   *
   * **Absent for a manual code**, and absent is not "neither" — it is "the
   * code did not say", which is a different thing and has to be answered by
   * looking everywhere the hub can look.
   */
  capabilities?: SetupCodeCapabilities;
  vendorId?: number;
  productId?: number;
}

export interface SetupCodeCapabilities {
  ble: boolean;
  onIpNetwork: boolean;
  /** Wi-Fi Public Action Frame, which no hub here speaks. Reported, not used. */
  wifiPublicActionFrame: boolean;
  nfc: boolean;
}

/** Every Matter QR payload starts with this. */
const QR_PREFIX = 'MT:';

/**
 * Matter core spec § 5.1.3.1, Table 60 — the Discovery Capabilities Bitmask.
 * Bit 0 is reserved (it was Soft-AP), so BLE is bit 1 and "already on the IP
 * network" is bit 2. Read here rather than through matter.js's own bitmap
 * schema so the shape crossing into the rest of the hub is four plain
 * booleans and nothing else.
 */
const CAPABILITY_BIT = {
  ble: 1,
  onIpNetwork: 2,
  wifiPublicActionFrame: 3,
  nfc: 4,
} as const;

function capabilitiesFrom(bits: number): SetupCodeCapabilities {
  const has = (bit: number): boolean => (bits & (1 << bit)) !== 0;
  return {
    ble: has(CAPABILITY_BIT.ble),
    onIpNetwork: has(CAPABILITY_BIT.onIpNetwork),
    wifiPublicActionFrame: has(CAPABILITY_BIT.wifiPublicActionFrame),
    nfc: has(CAPABILITY_BIT.nfc),
  };
}

/** A setup code the hub cannot make sense of, told apart from a pairing that failed. */
export class InvalidSetupCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSetupCodeError';
  }
}

/**
 * Decode a manual pairing code or a QR payload.
 *
 * Deliberately strict about *nothing* except being decodable: which forms are
 * plausible is the app's business (it refuses to send eight digits), and a
 * code that decodes but names an accessory that is not there is a pairing
 * failure with its own words, not a rejected string.
 */
export function parseSetupCode(raw: string): SetupCode {
  const trimmed = raw.trim();
  if (trimmed.toUpperCase().startsWith(QR_PREFIX)) {
    let payload;
    try {
      // A QR may carry several payloads concatenated (a multi-device box).
      // The first is the one the camera was pointed at.
      payload = QrPairingCodeCodec.decode(trimmed)[0];
    } catch (error) {
      throw new InvalidSetupCodeError(`That QR code isn't a Matter setup code: ${(error as Error).message}`);
    }
    if (!payload) throw new InvalidSetupCodeError("That QR code isn't a Matter setup code.");
    return {
      passcode: payload.passcode,
      longDiscriminator: payload.discriminator,
      capabilities: capabilitiesFrom(payload.discoveryCapabilities),
      vendorId: payload.vendorId,
      productId: payload.productId,
    };
  }

  const digits = trimmed.replace(/[^0-9]/g, '');
  let payload;
  try {
    payload = ManualPairingCodeCodec.decode(digits);
  } catch (error) {
    throw new InvalidSetupCodeError(`That isn't a Matter setup code: ${(error as Error).message}`);
  }
  return {
    passcode: payload.passcode,
    ...(payload.shortDiscriminator !== undefined
      ? { shortDiscriminator: payload.shortDiscriminator }
      : {}),
    ...(payload.vendorId !== undefined ? { vendorId: payload.vendorId } : {}),
    ...(payload.productId !== undefined ? { productId: payload.productId } : {}),
  };
}

/**
 * Where to look for this accessory, given what the code said and what this hub
 * can actually do.
 *
 * Two rules. **A code that said nothing is asked about everywhere** — a manual
 * code carries no capability bits, and a hub that guessed "IP only" there is
 * how a perfectly good accessory becomes a screen that spins for ever. And
 * **a hub without BLE still looks on IP even when the code says BLE**, because
 * the accessory may have been commissioned elsewhere since the label was
 * printed and be sitting on the network under multi-admin — the refusal that
 * belongs to "this needs Bluetooth" is worth saying, but only after looking.
 */
export function discoveryCapabilitiesFor(
  code: SetupCode,
  hub: { ble: boolean },
): { ble: boolean; onIpNetwork: boolean } {
  const said = code.capabilities;
  return {
    ble: hub.ble && (said === undefined || said.ble),
    onIpNetwork: said === undefined || said.onIpNetwork || !hub.ble,
  };
}

/**
 * Whether this code names an accessory only Bluetooth could reach, on a hub
 * that has none — the one case worth refusing *before* a two-minute search,
 * because the answer cannot change while somebody waits for it.
 */
export function needsBluetooth(code: SetupCode, hub: { ble: boolean }): boolean {
  const said = code.capabilities;
  return !hub.ble && said !== undefined && said.ble && !said.onIpNetwork;
}
