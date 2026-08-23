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
import { readRadioMode } from './radio.js';
import { readZigbeeProblem, type ZigbeeProblem } from '../adapters/zigbee/diagnosis.js';

/** How long a diagnosis is reused before the log is read again. */
const PROBLEM_TTL_MS = 30_000;

export interface HubStatusSnapshot {
  zigbee: {
    enabled: boolean;
    connected: boolean;
    permitJoin: { active: boolean; remainingSeconds: number };
    problem?: ZigbeeProblem;
  };
  radio: {
    budget: 'both' | 'one';
    mode: 'auto' | 'zigbee' | 'matter';
    matter: boolean;
    canRunBoth: boolean;
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

  const zigbee = (): HubStatusSnapshot['zigbee'] => {
    const enabled = deps.zigbee !== undefined;
    const connected = deps.zigbee?.connected ?? false;
    // Whether the network is open belongs on the health check, not only on the
    // event stream: an app that reconnects, or that has just been opened, has
    // no other way to learn it and used to draw a "Close Network" button over a
    // network that closed minutes earlier.
    const permitJoin = deps.permitJoin.state;
    if (!enabled || connected) {
      problemCache = undefined;
      return { enabled, connected, permitJoin };
    }
    const now = Date.now();
    if (problemCache === undefined || now - problemCache.at > PROBLEM_TTL_MS) {
      problemCache = { at: now, problem: readZigbeeProblem(deps.z2mDataDir) };
    }
    const { problem } = problemCache;
    return { enabled, connected, permitJoin, ...(problem !== undefined ? { problem } : {}) };
  };

  return {
    snapshot: () => ({
      zigbee: zigbee(),
      // What this hub can actually talk to is not the same on every machine: a
      // 512 MB board affords one radio, so an app that showed "Matter"
      // unconditionally would be lying on half the hardware.
      radio: {
        /** 'one' when Matter and Zigbee2MQTT don't fit together on this board. */
        budget: deps.radioBudget,
        /** What the owner asked for; 'auto' means "follow the hardware". */
        mode: readRadioMode(deps.dataDir),
        /** Live, not requested — a switch takes a moment to apply. */
        matter: deps.matter !== undefined,
        /** True only when the board could run both at once. */
        canRunBoth: deps.radioBudget === 'both',
      },
    }),
  };
}
