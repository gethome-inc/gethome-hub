// What this hub can talk to, in one shape, built in one place.
//
// The `zigbee` and `radio` blocks on `GET /hub` are also what the `hubStatus`
// WebSocket frame carries, and they must not be two shapes that drift: an app
// deciding whether to offer Zigbee pairing reads whichever arrives first. So
// the snapshot lives here and both callers take it from the same function.
//
// The import of `ApiDeps` is **type-only** and therefore erased — this module
// pulls nothing from the API layer at runtime, the same rule
// `core/zigbee-events.ts` follows for the Zigbee adapter.
import type { ApiDeps } from '../api/server.js';
import {
  MAX_AUTO_RETRIES,
  RADIO_APPLY_WINDOW_MS,
  RADIO_MODES,
  readRadioMode,
  readRadioRequest,
  readRadioStandDown,
  type RadioMode,
  type StandDownReason,
} from './radio.js';
import { readZigbeeProblem, type ZigbeeProblem } from '../adapters/zigbee/diagnosis.js';
import { readCoordinatorPresence, type CoordinatorPresence } from '../adapters/zigbee/coordinator.js';
import type { BleUnavailableReason } from '../adapters/matter/ble.js';

/** How long a diagnosis is reused before the log is read again. */
const PROBLEM_TTL_MS = 30_000;
/**
 * How long the coordinator's presence is reused.
 *
 * Shorter than the diagnosis's because this one *does* change from one second
 * to the next — somebody plugs a stick in and expects the app to notice — and
 * the read is two file operations rather than sixty-four kilobytes of log.
 */
const COORDINATOR_TTL_MS = 5_000;

export interface HubStatusSnapshot {
  zigbee: {
    enabled: boolean;
    connected: boolean;
    /**
     * Whether a coordinator is plugged into this machine, which is a different
     * question from whether Zigbee is running and needs opposite words in an
     * app. See `adapters/zigbee/coordinator.ts`.
     */
    coordinator: CoordinatorPresence;
    permitJoin: { active: boolean; remainingSeconds: number };
    problem?: ZigbeeProblem;
  };
  radio: {
    budget: 'both' | 'one';
    mode: RadioMode;
    matter: boolean;
    canRunBoth: boolean;
    /**
     * Every mode this hub understands.
     *
     * Feature detection rather than a version number, the way `history`,
     * `portraits` and `matter` are — and here it is the difference between an
     * app offering "run both radios" and an app whose only way to find out is
     * a 400. `both` arrived after the other three, so a hub older than it
     * answers a list without it and an app reads that as "don't offer".
     */
    modes: readonly RadioMode[];
    /**
     * The hub having taken a radio back off this board by itself.
     *
     * Present once it has ever happened, which is deliberately longer than the
     * notice it raises: `acknowledged` is what ends the notice — somebody set
     * a radio deliberately, so they have seen where they were left — while
     * `count` is this board's history with running both and outlives every
     * acknowledgement. An app about to offer the switch again should say it.
     */
    standDown?: {
      at: number;
      reason: StandDownReason;
      detail?: string;
      count: number;
      acknowledged: boolean;
      /**
       * The owner asked for both radios and the hub is not running them.
       *
       * **Suspended, not revoked** — the choice is still recorded, and this is
       * what says so. An app that only knew the mode had gone back to `auto`
       * would have to present the switch as untouched, which reads as the hub
       * having quietly undone a decision rather than having parked it.
       */
      suspended: boolean;
      /**
       * The hub will try both again by itself.
       *
       * False once the tries are spent, which is the sentence somebody needs:
       * *the hub has stopped trying, and you can still turn it on.* It says
       * nothing about **when** — the answer is "next time this board
       * restarts, or within a week" — because a countdown to a restart that
       * has to happen anyway is a number nobody can use.
       */
      willRetry: boolean;
    };
    /**
     * The board running short of memory, right now, on any hardware.
     *
     * Deliberately **not** only a small-board concern: a Pi 5 whose memory is
     * being eaten has exactly the same symptom and a completely different
     * answer, and saying nothing there because the hub has no move to make is
     * how a home degrades quietly. `willStandDown` is the difference —
     * *something is about to happen* against *somebody should look at this*.
     *
     * Live, so it clears on its own; a stand-down is what is left behind.
     */
    pressure?: { since: number; detail: string; willStandDown: boolean };
    /**
     * Whether a switch asked for a moment ago is still landing.
     *
     * Read from the data directory rather than held in memory, because
     * applying a radio **restarts this process** — so the only useful answer
     * is one that survives the restart it is describing. `applyingSince` is
     * the millisecond it was asked for, so a screen shows a bar rather than a
     * spinner, and `applyingWindowMs` is how long the hub is prepared to claim
     * it: a client that has to guess either would guess differently in every
     * app.
     */
    applying: boolean;
    applyingSince?: number;
    applyingWindowMs: number;
  };
  /**
   * What Matter pairing this hub can actually do.
   *
   * Present whenever Matter is running, absent otherwise — the same feature
   * detection `history` and `portraits` use on `GET /hub`, never a version
   * number. It exists because an accessory that has never been on a network
   * can only be found over Bluetooth, so a hub without it can pair a minority
   * of what people buy, and an app that offered the whole flow anyway would be
   * offering a three-minute wait with one possible ending.
   */
  matter?: {
    /** Whether a factory-new accessory can be found at all. */
    bluetooth: boolean;
    /** Why not, when it can't — the fix is different for each. */
    bluetoothReason?: BleUnavailableReason;
    /** Whether the hub can hand that accessory a network of its own. */
    wifi: boolean;
    /** A pairing is running right now, so a second one would be refused. */
    commissioning: boolean;
    /**
     * Epoch ms until which Matter is still finding the devices it owns.
     *
     * **A device is not offline because the hub has only just started looking
     * for it.** Zigbee2MQTT hands its whole device list over in one retained
     * message; a Matter controller opens a CASE session per node, which is
     * twenty to thirty seconds on a Zero 2 W — and those devices were read
     * back from the database with the `online: false` they were given when
     * Matter was last switched off. So a working home read "1 offline · needs
     * attention" for half a minute after every switch to Matter, about an
     * accessory that was about to answer.
     *
     * Absent means settled, and it goes absent **when the last node connects**
     * rather than when the clock runs out. What the clock bounds is the node
     * that never answers — the one genuinely offline device, which must not
     * be hidden behind "still looking" for ever.
     */
    settlingUntil?: number;
  };
}

export interface HubStatusReader {
  snapshot(): HubStatusSnapshot;
}

/**
 * Reads the hub's live capability picture.
 *
 * The Zigbee diagnosis is cached for 30 s and only consulted while Zigbee is
 * enabled-but-not-connected: `GET /hub` is public and is the health check every
 * app and installer polls, so it must not become a file read per request — and
 * a failure that has just been diagnosed does not change from one second to the
 * next. A healthy hub never touches the disk for this.
 */
export function createHubStatusReader(deps: ApiDeps): HubStatusReader {
  let problemCache: { at: number; problem: ZigbeeProblem | undefined } | undefined;
  let coordinatorCache: { at: number; presence: CoordinatorPresence } | undefined;

  /**
   * Is the stick there? Cached, because this sits behind the health check every
   * app and installer polls — and answered without touching the disk at all
   * while Zigbee is connected, which is proof enough on its own.
   */
  const coordinator = (connected: boolean): CoordinatorPresence => {
    if (connected) return 'present';
    const now = Date.now();
    if (coordinatorCache === undefined || now - coordinatorCache.at > COORDINATOR_TTL_MS) {
      coordinatorCache = { at: now, presence: readCoordinatorPresence(deps.zigbeeEnvFile) };
    }
    return coordinatorCache.presence;
  };

  const zigbee = (): HubStatusSnapshot['zigbee'] => {
    const enabled = deps.zigbee !== undefined;
    const connected = deps.zigbee?.connected ?? false;
    // Whether the network is open belongs on the health check, not only on the
    // event stream: an app that reconnects, or that has just been opened, has
    // no other way to learn it and used to draw a "Close Network" button over a
    // network that closed minutes earlier.
    const permitJoin = deps.permitJoin.state;
    const present = coordinator(connected);
    if (!enabled || connected) {
      problemCache = undefined;
      return { enabled, connected, coordinator: present, permitJoin };
    }
    const now = Date.now();
    if (problemCache === undefined || now - problemCache.at > PROBLEM_TTL_MS) {
      problemCache = { at: now, problem: readZigbeeProblem(deps.z2mDataDir) };
    }
    const { problem } = problemCache;
    return {
      enabled,
      connected,
      coordinator: present,
      permitJoin,
      ...(problem !== undefined ? { problem } : {}),
    };
  };

  return {
    snapshot: () => {
      const zigbeeNow = zigbee();
      const matterNow = deps.matter !== undefined;
      const mode = readRadioMode(deps.dataDir);
      // **A switch is over when what was asked for is live, not when the
      // window runs out.** The window is a bound for the requests that can
      // never be satisfied — asking for Zigbee on a hub with no coordinator
      // correctly changes nothing — and it was doing duty for both, so a mode
      // change that resolved to the radio already running (`auto` → `matter`
      // on a hub already on Matter, which `gethome-zigbee-detect` correctly
      // answers by restarting nothing) left every app drawing "switching
      // radios" for two and a half minutes over a hub that was never going
      // anywhere. `auto` keeps the window, because it names no single target
      // to check against — and `both` names two, so it is only over once they
      // are *both* there, which is the one mode that can land in two stages.
      // **A mode names the whole arrangement, not one radio.** Asking whether
      // the wanted radio is up was right for every switch that turns one on
      // and wrong for every switch that turns one *off*: leaving `both` for
      // `zigbee` left Zigbee already connected, so this read as landed the
      // instant the request was recorded — no progress bar, no planned
      // downtime, and then the hub went off the network for seventy seconds
      // with nothing on screen to say why. `both` → `matter` had it too. So
      // each mode asserts what must be *off* as well as what must be on.
      const landed =
        (mode === 'matter' && matterNow && !zigbeeNow.connected) ||
        (mode === 'zigbee' && zigbeeNow.connected && !matterNow) ||
        (mode === 'both' && matterNow && zigbeeNow.connected);
      const request = landed ? undefined : readRadioRequest(deps.dataDir);
      // **Deliberately not cached, unlike the two reads above it.** The rule
      // those obey is that `GET /hub` is the health check every app and
      // installer polls, so it must not become a *file read* per request — and
      // the read that rule was written for is `readZigbeeProblem`, which is
      // sixty-four kilobytes of log. This is one `open` that fails with ENOENT
      // on every hub this has never happened to, which is nearly all of them.
      //
      // And a cache here would buy those microseconds at the price of a
      // staleness bug on the one route where the value moves:
      // `PUT /settings/radio` acknowledges the notice and then answers with
      // this very snapshot, so a TTL of any length would hand the app that
      // just dismissed it an `acknowledged: false`.
      const standDown = readRadioStandDown(deps.dataDir);
      // In memory, not on disk — pressure is a thing that is happening rather
      // than a thing that happened, and it has to be able to stop.
      const pressure = deps.radioPressure?.pressure();
      return {
        zigbee: zigbeeNow,
        // What this hub can actually talk to is not the same on every machine: a
        // 512 MB board affords one radio, so an app that showed "Matter"
        // unconditionally would be lying on half the hardware.
        radio: {
          /** 'one' when Matter and Zigbee2MQTT don't fit together on this board. */
          budget: deps.radioBudget,
          /** What the owner asked for; 'auto' means "follow the hardware". */
          mode,
          /** Live, not requested — a switch takes a moment to apply. */
          matter: matterNow,
          /** True only when the board could run both at once. */
          canRunBoth: deps.radioBudget === 'both',
          applying: request !== undefined,
          ...(request !== undefined ? { applyingSince: request.at } : {}),
          applyingWindowMs: RADIO_APPLY_WINDOW_MS,
          /** What this build can be asked for — never a version number. */
          modes: RADIO_MODES,
          ...(standDown !== undefined
            ? {
                standDown: {
                  at: standDown.at,
                  reason: standDown.reason,
                  ...(standDown.detail !== undefined ? { detail: standDown.detail } : {}),
                  count: standDown.count,
                  acknowledged: standDown.acknowledgedAt !== undefined,
                  // Both computed from the mode *and the budget* as well as
                  // the record, because the question is about now: a hub that
                  // has since been put back on both owes nobody anything,
                  // whatever its history — and neither does one whose board
                  // has changed underneath it.
                  //
                  // **The budget is the half that was missing, and an SD card
                  // is why.** A stand-down is a small board's fact; a record
                  // travels with the card into a bigger Pi, where `auto`
                  // already runs both radios. Without this the apps drew "Your
                  // hub went back to one radio", with a button offering to try
                  // both again, over a hub that was running both — permanently,
                  // since the watch only ever restores while *one* radio is
                  // live and there was nothing here to clear the record.
                  suspended:
                    deps.radioBudget === 'one' &&
                    standDown.wish === 'both' &&
                    mode !== 'both',
                  willRetry:
                    deps.radioBudget === 'one' &&
                    standDown.wish === 'both' &&
                    mode !== 'both' &&
                    standDown.autoRetries < MAX_AUTO_RETRIES,
                },
              }
            : {}),
          ...(pressure !== undefined ? { pressure } : {}),
        },
        ...(deps.matter !== undefined
          ? {
              matter: {
                bluetooth: deps.matter.bleStatus.enabled,
                ...(deps.matter.bleStatus.reason !== undefined
                  ? { bluetoothReason: deps.matter.bleStatus.reason }
                  : {}),
                wifi: deps.matter.hasWifiCredentials,
                commissioning: deps.matter.isCommissioning,
                ...(deps.matter.settlingUntil !== undefined
                  ? { settlingUntil: deps.matter.settlingUntil }
                  : {}),
              },
            }
          : {}),
      };
    },
  };
}
