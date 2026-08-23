import { EventEmitter } from 'node:events';
import type { AdapterId } from '../adapters/adapter.js';
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
  activity: [entry: ActivityEvent];
  permitJoin: [active: boolean, remainingSeconds: number];
  /**
   * A whole radio came up or went down.
   *
   * Not the per-device `deviceUpserted` storm that follows it: those say which
   * devices went, and this says *why*. Without it an app watched six Zigbee
   * devices grey out while its own "Zigbee · on" chip sat unchanged, because
   * what a hub can talk to only ever reached it through `GET /hub` and nothing
   * asks for that when a stick is pulled out.
   */
  radioChanged: [adapter: AdapterId, reachable: boolean];
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

/**
 * One line of the home's history, as stored and as broadcast.
 *
 * `message` is the whole sentence and is what a client renders when it knows
 * nothing else — Studio does exactly that. `data` is the same facts in
 * structured form, so an app can compose its own sentence, pick an icon and a
 * tone, and fold a burst: `deviceName`/`memberName` are carried in it because
 * both foreign keys are `ON DELETE SET NULL`, so a row read next week may name
 * a device or a member that no longer exists. Optional, and every consumer
 * must survive its absence — rows written before it existed have none.
 */
export interface ActivityEvent {
  id: number;
  at: string;
  kind: string;
  message: string;
  deviceId?: string;
  memberId?: string;
  data?: Record<string, unknown>;
}

export class HubEventBus extends EventEmitter<HubEvents> {
  constructor() {
    super();
    // WS fan-out attaches one listener per connected client.
    this.setMaxListeners(100);
  }
}
