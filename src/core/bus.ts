import { EventEmitter } from 'node:events';
import type { EndpointState } from '../schema/index.js';

/** Events the hub fans out to WebSocket clients (and internal listeners). */
export interface HubEvents {
  deviceUpserted: [deviceId: string];
  deviceRemoved: [deviceId: string];
  stateChanged: [deviceId: string, endpointId: number, state: EndpointState];
  activity: [entry: ActivityEvent];
  permitJoin: [active: boolean, remainingSeconds: number];
  commissioningProgress: [jobId: string, status: string, detail?: string];
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
