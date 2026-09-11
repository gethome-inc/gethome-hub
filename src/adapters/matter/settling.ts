/**
 * How long the hub is still *looking* for the Matter devices it already owns.
 *
 * **A device is not offline because the hub has only just started looking for
 * it.** Zigbee2MQTT hands its whole device list over in one retained message,
 * so a Zigbee home is complete a second after the radio is. A Matter
 * controller has to open a CASE session with every node in turn, over Wi-Fi,
 * and on a Zero 2 W that is twenty to thirty seconds — while those devices sit
 * in the database with the `online: false` they were given when Matter was
 * last switched *off*. So every switch to Matter reported "1 offline · needs
 * attention" for half a minute about an accessory that was about to answer.
 *
 * The arithmetic lives here rather than in `adapter.ts` for the reason
 * `reducer.ts`, `setup-code.ts` and `commission-failures.ts` do: importing the
 * adapter loads `@matter/main`, by far the largest thing in the dependency
 * graph, so a rule that can only be read through it is a rule no test can
 * reach. This one is read by every screen in both apps.
 */

/**
 * How long a started controller is given to reach the nodes it owns.
 *
 * Measured at twenty to thirty seconds on a Raspberry Pi Zero 2 W for one
 * node — a CASE session per accessory, over Wi-Fi, on a 1 GHz A53 — so a
 * minute is the bound rather than the expectation. It is only ever *reached*
 * by a node that is genuinely not there.
 */
export const NODE_SETTLE_MS = 60 * 1000;

/**
 * How long the controller itself is given to come up.
 *
 * `MatterAdapter.start()` runs **after** the API is already listening —
 * deliberately, so that matter.js opening its storage on a slow SD card cannot
 * hold the health check and the claim closed — which means every `GET /hub` in
 * those seconds is answered by an adapter that has not begun looking yet. A
 * minute is far more than it has ever taken, and it is a bound on a `start()`
 * that never returns rather than an expectation: a controller that is not
 * coming must stop being an excuse for devices that are genuinely unreachable.
 */
export const CONTROLLER_START_MS = 60 * 1000;

/** Where the adapter is in its own start-up, and what it has reached. */
export interface SettlingPhase {
  /** When `start()` was entered. 0 before that, and 0 again if it failed. */
  startingAt: number;
  /** When the controller was up and the nodes had been told to connect. */
  startedAt: number;
  /** The nodes this controller is commissioned to, by external id. */
  commissioned: readonly string[];
  /** Those it has reached at least once since it started. */
  connected: ReadonlySet<string>;
}

/**
 * The moment after which a silent Matter device is honestly offline, or
 * `undefined` when there is nothing left to wait for.
 *
 * **Two phases, each with its own bound, and only the second runs the node
 * budget.** The controller coming up is time in which no node *could* report
 * in, so counting it against them would shorten the window they actually get;
 * and saying nothing during it was the same bug one step earlier — a hub that
 * had not begun looking, reporting a settled home, while `GET /hub` answered
 * `radio.matter: true` because the adapter had been constructed.
 *
 * Absent means settled, and in the second phase it becomes absent **the moment
 * the last node connects** rather than when the clock runs out: the controller
 * knows what it is commissioned to and what it has reached, so there is
 * nothing to guess. The clock is only ever reached by the node that never
 * answers — which is the one genuinely offline device, and which must not be
 * hidden behind a "still looking" for ever.
 */
export function settlingUntil(phase: SettlingPhase, now: number): number | undefined {
  if (phase.startedAt === 0) {
    if (phase.startingAt === 0) return undefined;
    const starting = phase.startingAt + CONTROLLER_START_MS + NODE_SETTLE_MS;
    return now < starting ? starting : undefined;
  }
  const until = phase.startedAt + NODE_SETTLE_MS;
  if (now >= until) return undefined;
  // Nothing owned, nothing to look for. A hub that has never paired an
  // accessory must not spend its first minute explaining an empty home.
  if (phase.commissioned.length === 0) return undefined;
  if (phase.commissioned.every((nodeId) => phase.connected.has(nodeId))) return undefined;
  return until;
}
