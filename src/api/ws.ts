import type { WebSocket } from 'ws';
import type { ApiDeps } from './server.js';
import { deviceWire } from './dto.js';

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
 */
export function attachWebSocket(socket: WebSocket, deps: ApiDeps): void {
  const send = (frame: Record<string, unknown>) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
  };

  send({ type: 'hello', hubId: deps.hubId, name: deps.hubName, apiVersion: 1 });

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

  socket.on('close', () => {
    deps.events.off('stateChanged', onState);
    deps.events.off('deviceUpserted', onUpserted);
    deps.events.off('deviceRemoved', onRemoved);
    deps.events.off('activity', onActivity);
    deps.events.off('permitJoin', onPermitJoin);
    deps.events.off('commissioningProgress', onCommissioning);
  });
}
