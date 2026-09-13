/**
 * Why a Matter pairing didn't work, in words somebody can act on.
 *
 * `POST /matter/commission` used to answer a failed job with matter.js's own
 * message — `discovery of node with discriminator 1938 failed: No
 * commissionable device was discovered` — which names the right fact in a
 * vocabulary nobody in the house speaks, and, worse, offers no next step for
 * the case that is nearly always true: the accessory was never in pairing mode,
 * or it needs Bluetooth and this hub hasn't got any.
 *
 * The shape is `write-failures.ts`'s, and so are its two rules. **`kind` is an
 * open string**: a client that meets a word it has never heard falls back to
 * the sentence, so adding a kind never breaks an app. And **classification is
 * most-specific-first**, because these co-occur — a device that refuses PASE
 * also produces a discovery that found nothing to commission, and the specific
 * one is the only one that helps.
 */
export type CommissionFailureKind =
  /** Nothing answered anywhere the hub could look. */
  | 'not-found'
  /** The code says Bluetooth and this hub has none. Refused before searching. */
  | 'needs-bluetooth'
  /** Found over Bluetooth, but the hub has no Wi-Fi password to hand over. */
  | 'needs-wifi'
  /** The code is not a Matter setup code, or its checksum is wrong. */
  | 'bad-code'
  /** It answered and refused the passcode. */
  | 'wrong-code'
  /** It is still commissioned somewhere else, or has no room for another home. */
  | 'already-paired'
  /** Somebody pressed Cancel. */
  | 'cancelled'
  /** Anything else, carrying matter.js's own words. */
  | 'failed';

export interface CommissionFailure {
  kind: CommissionFailureKind;
  /** One sentence, safe to show as-is. */
  summary: string;
  /** What the library actually said, for a disclosure. */
  detail?: string;
}

/** The one sentence each kind gets, so the hub and its apps agree on the words. */
const SUMMARY: Record<CommissionFailureKind, string> = {
  'not-found':
    "The hub looked for that accessory and didn't find it. Most of the time it isn't in pairing mode — " +
    'hold its button until the light blinks and try the code again. Keep it near the hub while it pairs.',
  'needs-bluetooth':
    'That accessory can only be found over Bluetooth, and this hub has none available. An accessory ' +
    'already on your network pairs without it.',
  'needs-wifi':
    "The hub found the accessory but has no Wi-Fi password to give it, so the accessory has no network to " +
    'join. Enter your Wi-Fi password and try again.',
  'bad-code':
    "That isn't a Matter setup code. Check the digits on the accessory or its box, or point the camera at " +
    'the QR code instead.',
  'wrong-code':
    "The accessory answered but wouldn't accept that code. Check the digits, and make sure you are using " +
    "this accessory's own code rather than one from another box.",
  'already-paired':
    'The accessory is still paired to another home. Remove it there, or reset it by holding its button ' +
    'until the light blinks, and try again.',
  cancelled: 'Pairing was cancelled.',
  failed: "The hub couldn't finish pairing that accessory.",
};

export function commissionFailure(kind: CommissionFailureKind, detail?: string): CommissionFailure {
  return { kind, summary: SUMMARY[kind], ...(detail !== undefined ? { detail } : {}) };
}

/**
 * A pairing that failed for a reason the hub can name.
 *
 * Here rather than beside the adapter because the API layer catches it, and
 * this module imports nothing: the Matter adapter is a **dynamic** import in
 * `src/index.ts` precisely so `@matter/main` — by far the largest thing in the
 * graph — stays out of a hub that isn't running it, and an error class reached
 * through `adapter.ts` would have loaded the lot to read one field.
 */
export class CommissionError extends Error {
  constructor(readonly failure: CommissionFailure) {
    super(failure.summary);
    this.name = 'CommissionError';
  }
}

/**
 * Read matter.js's error and name what happened.
 *
 * Deliberately matched on the message rather than on error classes: matter.js
 * pins to a minor here *because* its API churns, and a class that is renamed
 * turns an `instanceof` chain into a silent fall-through to "failed" — while a
 * message that changes shows up as one kind reverting to the generic, which is
 * the same outcome the unrecognised branch already gives.
 */
export function classifyCommissionError(error: unknown): CommissionFailure {
  const detail = error instanceof Error ? error.message : String(error);
  const text = detail.toLowerCase();

  // Most specific first. A refusal from the accessory is the only outcome here
  // that is about the *code* rather than about reaching the thing at all, and
  // the message carries a discovery failure around it either way.
  if (/invalid.*passcode|passcode.*(mismatch|invalid|incorrect)|pase.*(failed|error).*parameter/.test(text)) {
    return commissionFailure('wrong-code', detail);
  }
  if (/already.*commissioned|no more fabrics|fabric.*(full|limit)|window.*not open|failsafe.*busy|busy.*commission/.test(text)) {
    return commissionFailure('already-paired', detail);
  }
  if (/no commissionable device was discovered|no device could be commissioned|discovery.*failed/.test(text)) {
    return commissionFailure('not-found', detail);
  }
  return commissionFailure('failed', detail);
}
