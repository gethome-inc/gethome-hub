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
import { readRadioMode, readRadioRequest, RADIO_APPLY_WINDOW_MS } from './radio.js';
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
    mode: 'auto' | 'zigbee' | 'matter';
    matter: boolean;
    canRunBoth: boolean;
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
      // to check against.
      const landed =
        (mode === 'matter' && matterNow) || (mode === 'zigbee' && zigbeeNow.connected);
      const request = landed ? undefined : readRadioRequest(deps.dataDir);
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
              },
            }
          : {}),
      };
    },
  };
}
