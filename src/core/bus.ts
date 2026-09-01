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
  /**
   * A device's portraits changed — one was drawn, chosen, or deleted.
   *
   * Carries the device id and nothing else: the list is a short read and the
   * *bytes* are a megabyte or two, which is not something to push down a
   * socket. Always-on, and to every socket rather than the member who asked,
   * because a portrait is the house's — the phone in the next room is looking
   * at the same kettle and would otherwise keep the old picture until it
   * happened to reconnect. Same argument as `structure`.
   */
  portraitsChanged: [deviceId: string];
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
  /**
   * The hub's capability picture changed for a reason that isn't a radio
   * coming up or going down — today, somebody recording a new radio *mode*.
   *
   * It carries nothing because the answer is `core/hub-status.ts`'s whole
   * snapshot either way, and a payload here would be a second shape for a
   * fact that already has one. Kept separate from `radioChanged` because that
   * one is the registry's statement about reachability and has arguments that
   * would have to be invented to reuse it.
   *
   * Without this, `PUT /settings/radio` wrote a file and told nobody: an app
   * that had not made the change learned of it only by polling — and only if
   * it polls at all, and only ever *some* of the time, since a mode change
   * that doesn't move Matter doesn't restart the hub and so doesn't even
   * bounce the socket.
   */
  hubStatusChanged: [];
  /**
   * What one or more members may do has changed — their role was swapped, or
   * the role they hold was edited.
   *
   * Carries member ids rather than the new permissions, because the answer is
   * per member and `api/ws.ts` renders the frame per socket anyway (the same
   * reason `deviceUpserted` is rendered there and not on the bus). A role edit
   * has to reach an app that is already open, or somebody sits looking at
   * controls that have quietly stopped working — the argument that put
   * `structure` and `hubStatus` on the socket, applied to access.
   */
  /**
   * Somebody's roles or permissions moved. No payload: every socket renders
   * its own `access` frame, and the frame's `roles` half is shared — see
   * `AccessService.announce`.
   */
  accessChanged: [];
  /**
   * A write the hub forwarded did not land on the device.
   *
   * `POST /devices/:id/commands` answers 200 for anything it can route,
   * because routing is all it does: the Zigbee adapter publishes to MQTT, and
   * MQTT resolves when the *broker* takes the message. So a client that asks
   * for a value and watches the old one come back has had no way to tell "on
   * its way to a sleeping sensor" from "refused", and the apps papered over
   * the difference by silently reverting.
   *
   * It goes to **every** socket rather than only the one that asked, for the
   * same reason `structure` does: the value is the house's, so a write made on
   * one phone that fails is a fact the phone in the next room is also drawing.
   */
  commandFailed: [failure: CommandFailure];
  commissioningProgress: [jobId: string, status: string, detail?: string];
  mqttFrame: [frame: MqttFrame];
  zigbeeEvent: [event: ZigbeeLifecycleEvent];
  aiRun: [event: AiRunEvent];
  /**
   * An automation was created, edited, enabled, switched on, or removed.
   *
   * Always-on and to every socket, like `structure` and `portraits`: a rule is
   * the *house's*, so somebody switching "Night" on from the kitchen has to
   * reach the phone in the bedroom that is drawing the same card. It carries
   * the id and nothing else — the list is a short read, and a payload here
   * would be a second shape for a fact `GET /automations` already has.
   */
  automationChanged: [automationId: string];
  /**
   * A rule fired, or declined to.
   *
   * An **opt-in** stream, unlike the change above: this is the trace a person
   * watches while working out why the light came on, and a home with a motion
   * rule in it produces one of these every time somebody walks through the
   * hall. A phone drawing a dashboard must not pay for that.
   */
  automationRun: [event: AutomationRunEvent];
  /**
   * Something happened inside a conversation in which a rule is being written.
   *
   * On the same opt-in stream as `automationRun`, and for a sharper version of
   * the same reason: this carries the model's text **as it arrives**, so it is
   * the highest-rate thing the socket can emit, and it is of interest only to
   * the one client with the chat open. A phone drawing a dashboard must never
   * be attached to it.
   */
  automationChat: [event: AutomationChatEvent];
}

/**
 * One thing a conversation did, live.
 *
 * `delta` is text as the model produces it — a chat that shows nothing for
 * ninety seconds has failed whatever the model is doing. `step` is one line
 * per tool call or submission, which is what lets an app say "looking at your
 * devices" instead of spinning. `turn` says the exchange is over and the
 * stored messages are what to draw.
 */
export interface AutomationChatEvent {
  sessionId: string;
  phase: 'delta' | 'step' | 'turn';
  at: string;
  text: string;
  detail?: string;
}

/** One firing, as it happens. The stored trace is `automation_runs`. */
export interface AutomationRunEvent {
  automationId: string;
  name: string;
  at: string;
  /** manual | deviceState | deviceEvent | schedule | interval | action */
  trigger: string;
  /** One sentence naming what set it off. */
  cause: string;
  outcome: 'ran' | 'skipped' | 'refused' | 'failed' | 'interrupted';
  /** How many commands actually reached a device. */
  commands: number;
  /** How many a guard declined to send, and why the first one was declined. */
  refused: number;
  detail?: string;
}

/**
 * A command that reached the protocol and did not reach the device.
 *
 * `kind` is deliberately open (a plain `string`) rather than a union: the
 * adapters classify in their own vocabulary, an app that meets a word it does
 * not know falls back to `detail`, and a hub that learns a new one should not
 * need every client updated first. Today the Zigbee adapter answers
 * `unreachable` or `refused` — see `adapters/zigbee/write-failures.ts`, which
 * also explains why `superseded` never reaches here.
 */
export interface CommandFailure {
  deviceId: string;
  /** What was being written, in the vocabulary the client asked in. */
  property: string;
  kind: string;
  /** The protocol's own words. Apps show this rather than paraphrase it. */
  detail: string;
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
