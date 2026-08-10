import type { WebSocket } from 'ws';
import type { ApiDeps } from './server.js';
import { deviceWire } from './dto.js';

/** Controls a subscribed-but-not-yet-authorized WebSocket. */
export interface WebSocketHandle {
  /** Send the hello frame plus any events buffered during auth, then go live. */
  authorize(): void;
  /** Drop all listeners without ever sending a frame (auth failed). */
  close(): void;
}

/**
 * WebSocket event stream. Frames (JSON, one per message):
 *
 *   {"type":"hello","hubId","name","apiVersion":1}
 *   {"type":"state","deviceId","endpointId","state":{…full canonical state…}}
 *   {"type":"deviceUpserted","device":{…GET /devices item…}}
 *   {"type":"deviceRemoved","deviceId"}
 *   {"type":"activity","entry":{id,at,kind,message,deviceId?,memberId?}}
 *   {"type":"permitJoin","active","remainingSeconds"}
 *   {"type":"commissioning","jobId","status","detail"?}
 *
 * Listeners attach synchronously (before the caller's async token check) so an
 * event fired the instant the socket opens can't slip through the gap between
 * "connected" and "authorized". Frames are buffered until `authorize()`; a
 * failed auth calls `close()` and nothing is ever sent.
 */
export function attachWebSocket(socket: WebSocket, deps: ApiDeps): WebSocketHandle {
  let authorized = false;
  const backlog: string[] = [];
  const send = (frame: Record<string, unknown>) => {
    const data = JSON.stringify(frame);
    if (!authorized) {
      backlog.push(data);
      return;
    }
    if (socket.readyState === socket.OPEN) socket.send(data);
  };

  const onState = (deviceId: string, endpointId: number, state: unknown) =>
    send({ type: 'state', deviceId, endpointId, state });
  const onUpserted = (deviceId: string) => {
    const device = deps.registry.getDevice(deviceId);
    if (device) send({ type: 'deviceUpserted', device: deviceWire(device) });
  };
  const onRemoved = (deviceId: string) => send({ type: 'deviceRemoved', deviceId });
  const onActivity = (entry: unknown) => send({ type: 'activity', entry });
  const onPermitJoin = (active: boolean, remainingSeconds: number) =>
    send({ type: 'permitJoin', active, remainingSeconds });
  const onCommissioning = (jobId: string, status: string, detail?: string) =>
    send({ type: 'commissioning', jobId, status, ...(detail !== undefined ? { detail } : {}) });

  deps.events.on('stateChanged', onState);
  deps.events.on('deviceUpserted', onUpserted);
  deps.events.on('deviceRemoved', onRemoved);
  deps.events.on('activity', onActivity);
  deps.events.on('permitJoin', onPermitJoin);
  deps.events.on('commissioningProgress', onCommissioning);

  const detach = () => {
    deps.events.off('stateChanged', onState);
    deps.events.off('deviceUpserted', onUpserted);
    deps.events.off('deviceRemoved', onRemoved);
    deps.events.off('activity', onActivity);
    deps.events.off('permitJoin', onPermitJoin);
    deps.events.off('commissioningProgress', onCommissioning);
  };
  socket.on('close', detach);

  return {
    authorize() {
      if (authorized) return;
      authorized = true;
      if (socket.readyState !== socket.OPEN) return;
      // Read at send time, not captured at attach: the name can change under a
      // socket that is already open, and the next client to connect must be
      // told the current one.
      socket.send(JSON.stringify({ type: 'hello', hubId: deps.hubId, name: deps.home.name, apiVersion: 1 }));
      for (const data of backlog) socket.send(data);
      backlog.length = 0;
    },
    close() {
      backlog.length = 0;
      detach();
    },
  };
}
