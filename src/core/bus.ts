import { EventEmitter } from 'node:events';
import type { EndpointState } from '../schema/index.js';
import type { MqttFrame } from './mqtt-observer.js';

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
  commissioningProgress: [jobId: string, status: string, detail?: string];
  mqttFrame: [frame: MqttFrame];
  zigbeeEvent: [event: ZigbeeLifecycleEvent];
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
