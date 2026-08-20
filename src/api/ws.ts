import type { WebSocket } from 'ws';
import type { ApiDeps } from './server.js';
import type { MqttFrame } from '../core/mqtt-observer.js';
import type { ZigbeeLifecycleEvent } from '../core/bus.js';
import type { AiRunEvent } from '../core/ai-runs.js';
import { deviceWire } from './dto.js';

/** Controls a subscribed-but-not-yet-authorized WebSocket. */
export interface WebSocketHandle {
  /**
   * Send the hello frame plus any events buffered during auth, then go live.
   *
   * Takes the member because the socket has to be findable again: a member who
   * is removed has to lose the connection they are already holding, not just
   * the next one they open.
   */
  authorize(memberId: string): void;
  /** Drop all listeners without ever sending a frame (auth failed). */
  close(): void;
}

/**
 * What the hub closes a socket with when the token behind it is no good.
 *
 * **A cross-repo contract.** GetHome Studio reads this code to tell "the hub
 * refused us" from "the network hiccuped" and stops reconnecting on it, which
 * is the correct behaviour for both cases it covers: a token that never
 * authenticated, and one that has stopped counting because its member is gone.
 * Reconnecting cannot fix either, and inventing a second code for the second
 * case would make every existing client retry it for ever.
 */
export const UNAUTHORIZED_CLOSE_CODE = 4001;

/**
 * The live authorized sockets, by member.
 *
 * Authorization happens once, when a socket opens, so without this a member
 * removed from the home kept the connection they already had: every REST call
 * refused from the moment their row went, while device state carried on
 * streaming down a socket nobody could close. The gap closed whenever the
 * connection happened to drop — a hub restart, a Wi-Fi blip — which is to say,
 * unpredictably and possibly not for days.
 *
 * Registration is scoped to the socket's own life: `authorize` adds and the
 * `close` handler removes, so a hub that has been up for a month holds one
 * entry per connection that is actually open and none per connection that
 * isn't.
 */
export class MemberSessions {
  private readonly byMember = new Map<string, Set<() => void>>();

  register(memberId: string, revoke: () => void): void {
    const existing = this.byMember.get(memberId);
    if (existing) existing.add(revoke);
    else this.byMember.set(memberId, new Set([revoke]));
  }

  forget(memberId: string, revoke: () => void): void {
    const existing = this.byMember.get(memberId);
    if (!existing) return;
    existing.delete(revoke);
    if (existing.size === 0) this.byMember.delete(memberId);
  }

  /**
   * Close every socket this member holds. Returns how many, for the log.
   *
   * The set is copied before iterating: each `revoke` removes its own entry as
   * the socket tears down, and mutating a `Set` mid-iteration is how you skip
   * half of it.
   */
  revoke(memberId: string): number {
    const sockets = this.byMember.get(memberId);
    if (!sockets) return 0;
    const closing = [...sockets];
    for (const close of closing) close();
    this.byMember.delete(memberId);
    return closing.length;
  }
}

/** Streams a client can ask for beyond the always-on events. */
const OPTIONAL_STREAMS = ['mqtt', 'zigbee', 'ai'] as const;
type OptionalStream = (typeof OPTIONAL_STREAMS)[number];

/**
 * Most a socket is sent per second before frames start being counted instead
 * of forwarded. A Zigbee network with a few power meters on it publishes
 * steadily, and a hub whose job is the house must not spend a Zero 2 W's CPU
 * serialising traffic into an inspector nobody is reading that fast.
 */
const MQTT_FRAMES_PER_SECOND = 50;

/** Ignore oversized client frames rather than parsing them. */
const MAX_CLIENT_MESSAGE_BYTES = 4096;

/**
 * WebSocket event stream. Frames (JSON, one per message):
 *
 *   {"type":"hello","hubId","name","apiVersion":1,"streams":["mqtt","zigbee","ai"]}
 *   {"type":"state","deviceId","endpointId","state":{…full canonical state…}}
 *   {"type":"deviceUpserted","device":{…GET /devices item…}}
 *   {"type":"deviceRemoved","deviceId"}
 *   {"type":"activity","entry":{id,at,kind,message,deviceId?,memberId?}}
 *   {"type":"permitJoin","active","remainingSeconds"}
 *   {"type":"commissioning","jobId","status","detail"?}
 *
 * and, only for a client that asked for them:
 *
 *   {"type":"subscribed","streams":[…],"unavailable":[…]}
 *   {"type":"mqttBacklog","frames":[…]}      once, on subscribing to "mqtt"
 *   {"type":"mqtt","frame":{…}}
 *   {"type":"mqtt","dropped":N}              rate limit hit; N frames skipped
 *   {"type":"zigbeeEvent","event":{at,type,ieee,name?}}
 *   {"type":"aiRun","event":{phase,id,at,kind,exposesHash,step?,ok?,costUsd?}}
 *
 * Client → server (the only inbound frames read):
 *
 *   {"type":"subscribe","streams":["mqtt","zigbee"]}
 *   {"type":"unsubscribe","streams":["mqtt"]}
 *
 * **The optional streams are opt-in because they are not free.** The MQTT tap
 * is a wildcard subscription on the broker and can be thousands of messages a
 * minute; attaching it to every socket would make a phone showing a room of
 * lights pay for a developer tool it never opens. `hello` advertises what this
 * hub can offer so a client doesn't have to guess from its version, and a hub
 * with the MQTT adapter switched off simply lists fewer streams.
 *
 * Listeners for the always-on events attach synchronously (before the caller's
 * async token check) so an event fired the instant the socket opens can't slip
 * through the gap between "connected" and "authorized". Frames are buffered
 * until `authorize()`; a failed auth calls `close()` and nothing is ever sent.
 * A `subscribe` that arrives before authorization is held and applied then —
 * a client that sends it immediately must not be silently ignored.
 */
export function attachWebSocket(
  socket: WebSocket,
  deps: ApiDeps,
  sessions: MemberSessions,
): WebSocketHandle {
  let authorized = false;
  let closed = false;
  /** Whose socket this is, once it is authorized — the registry key. */
  let memberId: string | null = null;
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

  // ── Optional streams ──────────────────────────────────────────────────────

  const subscribed = new Set<OptionalStream>();
  let pendingRequest: OptionalStream[] | null = null;

  let windowStart = 0;
  let windowCount = 0;
  let droppedInWindow = 0;

  const onMqttFrame = (frame: MqttFrame) => {
    const now = Date.now();
    if (now - windowStart >= 1000) {
      // Report the previous second's losses on the first frame of this one.
      // Tying it to a frame rather than a timer means a hub that goes quiet
      // keeps no interval alive, and a hub that is dropping frames is by
      // definition about to send another one.
      if (droppedInWindow > 0) send({ type: 'mqtt', dropped: droppedInWindow });
      windowStart = now;
      windowCount = 0;
      droppedInWindow = 0;
    }
    if (windowCount >= MQTT_FRAMES_PER_SECOND) {
      droppedInWindow += 1;
      return;
    }
    windowCount += 1;
    send({ type: 'mqtt', frame });
  };

  const onZigbeeEvent = (event: ZigbeeLifecycleEvent) => send({ type: 'zigbeeEvent', event });
  const onAiRun = (event: AiRunEvent) => send({ type: 'aiRun', event });

  const available = (stream: OptionalStream): boolean =>
    stream === 'mqtt' ? deps.mqttObserver !== undefined : true;

  const subscribe = (streams: OptionalStream[]): void => {
    const unavailable: string[] = [];
    const accepted: string[] = [];
    for (const stream of streams) {
      if (!available(stream)) {
        unavailable.push(stream);
        continue;
      }
      accepted.push(stream);
      if (subscribed.has(stream)) continue;
      subscribed.add(stream);
      if (stream === 'mqtt' && deps.mqttObserver) {
        deps.mqttObserver.attach();
        deps.events.on('mqttFrame', onMqttFrame);
        send({ type: 'mqttBacklog', frames: deps.mqttObserver.recent() });
      }
      if (stream === 'zigbee') deps.events.on('zigbeeEvent', onZigbeeEvent);
      if (stream === 'ai') deps.events.on('aiRun', onAiRun);
    }
    send({
      type: 'subscribed',
      streams: accepted,
      ...(unavailable.length > 0 ? { unavailable } : {}),
    });
  };

  const unsubscribe = (streams: OptionalStream[]): void => {
    for (const stream of streams) {
      if (!subscribed.delete(stream)) continue;
      if (stream === 'mqtt') {
        deps.events.off('mqttFrame', onMqttFrame);
        deps.mqttObserver?.detach();
      }
      if (stream === 'zigbee') deps.events.off('zigbeeEvent', onZigbeeEvent);
      if (stream === 'ai') deps.events.off('aiRun', onAiRun);
    }
    send({ type: 'subscribed', streams: [...subscribed] });
  };

  const parseStreams = (value: unknown): OptionalStream[] => {
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is OptionalStream =>
      OPTIONAL_STREAMS.includes(entry as OptionalStream),
    );
  };

  socket.on('message', (data: unknown) => {
    if (closed) return;
    const text =
      typeof data === 'string'
        ? data
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : null;
    if (text === null || text.length > MAX_CLIENT_MESSAGE_BYTES) return;
    let parsed: { type?: string; streams?: unknown };
    try {
      parsed = JSON.parse(text) as { type?: string; streams?: unknown };
    } catch {
      return;
    }
    const streams = parseStreams(parsed.streams);
    if (streams.length === 0) return;
    if (parsed.type === 'subscribe') {
      // Held rather than dropped: a client that subscribes the moment it
      // connects is doing the sensible thing, and the token check is async.
      if (!authorized) pendingRequest = [...(pendingRequest ?? []), ...streams];
      else subscribe(streams);
      return;
    }
    if (parsed.type === 'unsubscribe') {
      if (!authorized) pendingRequest = (pendingRequest ?? []).filter((s) => !streams.includes(s));
      else unsubscribe(streams);
    }
  });

  /**
   * Hang up on this socket because its member is gone.
   *
   * Listeners come off first: closing a WebSocket is not instant, and a frame
   * fired in the meantime must not reach somebody who has just been removed.
   */
  const revoke = () => {
    detach();
    if (socket.readyState === socket.OPEN) {
      socket.close(UNAUTHORIZED_CLOSE_CODE, 'membership ended');
    }
  };

  const detach = () => {
    if (closed) return;
    closed = true;
    if (memberId !== null) {
      sessions.forget(memberId, revoke);
      memberId = null;
    }
    deps.events.off('stateChanged', onState);
    deps.events.off('deviceUpserted', onUpserted);
    deps.events.off('deviceRemoved', onRemoved);
    deps.events.off('activity', onActivity);
    deps.events.off('permitJoin', onPermitJoin);
    deps.events.off('commissioningProgress', onCommissioning);
    // Leaving these attached would leak one listener per socket against the
    // bus's cap of 100, and hold the broker tap open for a closed window.
    if (subscribed.has('mqtt')) {
      deps.events.off('mqttFrame', onMqttFrame);
      deps.mqttObserver?.detach();
    }
    if (subscribed.has('zigbee')) deps.events.off('zigbeeEvent', onZigbeeEvent);
    if (subscribed.has('ai')) deps.events.off('aiRun', onAiRun);
    subscribed.clear();
  };
  socket.on('close', detach);

  return {
    authorize(id: string) {
      // A socket that has already gone must not register: `detach` has run, so
      // nothing would ever take the entry back out again.
      if (authorized || closed) return;
      authorized = true;
      memberId = id;
      sessions.register(id, revoke);
      if (socket.readyState !== socket.OPEN) return;
      // Read at send time, not captured at attach: the name can change under a
      // socket that is already open, and the next client to connect must be
      // told the current one.
      socket.send(
        JSON.stringify({
          type: 'hello',
          hubId: deps.hubId,
          name: deps.home.name,
          apiVersion: 1,
          streams: OPTIONAL_STREAMS.filter(available),
        }),
      );
      for (const data of backlog) socket.send(data);
      backlog.length = 0;
      const requested = pendingRequest;
      pendingRequest = null;
      if (requested && requested.length > 0) subscribe(requested);
    },
    close() {
      backlog.length = 0;
      pendingRequest = null;
      detach();
    },
  };
}
