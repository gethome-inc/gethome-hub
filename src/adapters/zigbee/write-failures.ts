/**
 * Zigbee2MQTT's account of a `set` that did not land.
 *
 * **Why the hub reads a log line at all.** A write to a Zigbee device is
 * published to `<base>/<name>/set` and that is the end of the conversation:
 * MQTT resolves as soon as the broker accepts the message, and Z2M has no
 * per-command reply topic. So the hub answers 200 for every command it
 * forwards, and neither it nor any app can tell "delivered", "queued for a
 * sleeping device" and "refused" apart. The one place the difference is
 * written down is `bridge/logging`, which the adapter already receives and
 * used to drop on the floor.
 *
 * Reading another project's prose is a real cost, and this repo has paid it
 * once before with its eyes open — `diagnosis.ts` parses Z2M's log file to say
 * why a radio is down — so the same rule applies here: **an unrecognised line
 * yields `null`**. A wrong diagnosis is worse than the silence the caller
 * already has.
 *
 * The line looks like:
 *
 * ```
 * Publish 'set' 'detection_interval' to '0x54ef4410006387bc' failed:
 *   'Error: ZCL command … failed (Request superseded)'
 * ```
 */
export interface Z2mWriteFailure {
  /** The device's Zigbee2MQTT friendly name, as written in the log. */
  name: string;
  /** The expose/property being written — for a generic field, its id. */
  property: string;
  /** How the caller should read it. See `Z2mWriteFailureKind`. */
  kind: Z2mWriteFailureKind;
  /** Z2M's own words, for anything an app would rather show than paraphrase. */
  detail: string;
}

/**
 * Three outcomes, and only two of them are failures.
 *
 * - `superseded` — a **newer write to the same property replaced this one**
 *   while it sat in the queue. Nothing is wrong: the last write is still on
 *   its way, and reporting this as a failure would make somebody tapping −
 *   a few times watch four errors arrive for a value that is about to be set
 *   correctly. Callers ignore it; it is carried rather than dropped so the
 *   distinction is drawn in one place instead of at each of them.
 * - `unreachable` — the device never answered. On a **battery** device this is
 *   the ordinary case rather than a fault: a sleeping end device takes a
 *   queued write when it next checks in, and until then there is nothing to
 *   report but silence.
 * - `refused` — anything else Z2M said, passed through in its own words.
 */
export type Z2mWriteFailureKind = 'superseded' | 'unreachable' | 'refused';

/**
 * `Publish 'set' '<property>' to '<name>' failed: '<detail>'`
 *
 * The name is matched lazily and the trailing quote is optional because a
 * friendly name may itself contain a quote and Z2M does not escape it; the
 * property never does (it is an expose key).
 */
const SET_FAILURE = /Publish 'set' '([^']+)' to '(.+?)' failed:\s*'?(.*?)'?\s*$/;

/** The device simply never answered — herdsman has several ways to say it. */
const UNREACHABLE =
  /did not respond|timed? ?out|no ?ack|NO_NETWORK_ROUTE|MAC_?NO_ACK|Device is not|unavailable/i;

/**
 * One `bridge/logging` message as a structured failure, or `null` when the
 * line is not a failed `set` — which is nearly all of them.
 */
export function parseWriteFailure(message: string): Z2mWriteFailure | null {
  const match = SET_FAILURE.exec(message);
  if (!match) return null;

  const [, property, name, detail = ''] = match;
  if (!property || !name) return null;

  return { name, property, kind: classify(detail), detail: detail.trim() };
}

function classify(detail: string): Z2mWriteFailureKind {
  // Most specific first — the `diagnosis.ts` rule. A supersede error carries
  // the whole ZCL command in its text, so a generic "timed out" match placed
  // ahead of it would swallow the one outcome that is not a failure.
  if (/superseded/i.test(detail)) return 'superseded';
  if (UNREACHABLE.test(detail)) return 'unreachable';
  return 'refused';
}
