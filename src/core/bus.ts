import { EventEmitter } from 'node:events';
import type { EndpointState } from '../schema/index.js';
import type { MqttFrame } from './mqtt-observer.js';
import type { AiRunEvent } from './ai-runs.js';

/**
 * Events the hub fans out to WebSocket clients (and internal listeners).
 *
 * Everything above `mqttFrame` goes to every authorized socket. The three
 * below it are **opt-in streams** (`src/api/ws.ts`): they can be high-rate or
 * of interest only to a developer tool, and a phone showing a room of lights
 * must not pay for a traffic inspector nobody has open. A socket that never
 * subscribes never has a listener attached for them.
 */
export interface HubEvents {
  deviceUpserted: [deviceId: string];
  deviceRemoved: [deviceId: string];
  stateChanged: [deviceId: string, endpointId: number, state: EndpointState];
  /**
   * Rooms or zones changed — the whole of both lists, not a diff.
   *
   * A home has a handful of each, so the lists cost less than the round trip a
   * "go and refetch" frame would provoke, and there is no partial-update path
   * to get wrong. Everyone in the house is looking at the same rooms, so one
   * person adding a room has to reach the other phones without waiting for
   * them to reconnect — which was the only thing that used to re-read them.
   */
  structureChanged: [structure: HomeStructure];
  activity: [entry: ActivityEvent];
  permitJoin: [active: boolean, remainingSeconds: number];
  commissioningProgress: [jobId: string, status: string, detail?: string];
  mqttFrame: [frame: MqttFrame];
  zigbeeEvent: [event: ZigbeeLifecycleEvent];
  aiRun: [event: AiRunEvent];
}

/**
 * A device arriving on, or leaving, the Zigbee network.
 *
 * Zigbee2MQTT's own vocabulary (`device_interview` with a `status` field) is
 * normalized here rather than passed through, so the apps learn one set of
 * names and an upstream rename is a change in one file.
 */
export interface ZigbeeLifecycleEvent {
  at: string;
  type: 'joined' | 'announced' | 'interviewing' | 'interviewed' | 'interview-failed' | 'left';
  ieee: string;
  name?: string;
}

/** The shape of the home: its rooms, and the zones some of them sit in. */
export interface HomeStructure {
  rooms: Array<{
    id: string;
    name: string;
    zoneId: string | null;
    /** App-defined glyph and palette tokens; null is "the app decides". */
    icon: string | null;
    accent: string | null;
    sortOrder: number;
  }>;
  zones: Array<{ id: string; name: string; sortOrder: number }>;
}

export interface ActivityEvent {
  id: number;
  at: string;
  kind: string;
  message: string;
  deviceId?: string;
  memberId?: string;
}

export class HubEventBus extends EventEmitter<HubEvents> {
  constructor() {
    super();
    // WS fan-out attaches one listener per connected client.
    this.setMaxListeners(100);
  }
}
