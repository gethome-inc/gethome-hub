import mqtt from 'mqtt';
import type { AdapterBus, AdapterDeviceDescriptor, CameraSource, ProtocolAdapter } from '../adapter.js';
import {
  mqttDiscoverySchema,
  statePatchSchema,
  type CapabilityKind,
  type HubCommand,
  type MqttDiscoveryConfig,
} from '../../schema/index.js';
import { cameraTopic, commandTopic, configTopic, heartbeatTopic, parseTopic, subscriptionPatterns } from './convention.js';
import { HeartbeatWatch, readHeartbeat } from './heartbeat.js';
import type { Logger } from '../../logging.js';
import { brokerCredentials } from '../../mqtt-auth.js';
import { publicStream, readCameraAnnouncement, type CameraStreamSource } from '../../cameras/policy.js';

export interface MqttAdapterOptions {
  mqttUrl: string;
  /**
   * Broker credentials, when the broker asks for them. Empty on a hub
   * installed before `install.sh` started minting them — the drop-in it
   * writes then still says `allow_anonymous true`, so an anonymous connect is
   * the correct behaviour rather than a fallback.
   */
  username?: string;
  password?: string;
  log: Logger;
  /** The clock a device's heartbeat is judged by. Tests set it. */
  now?: () => number;
}

/** How often the adapter looks for devices that have gone quiet past their heartbeat. */
const HEARTBEAT_SWEEP_MS = 5_000;

/**
 * Camera announcements kept for devices the hub hasn't met yet, so a retained
 * camera message that arrives before its retained discovery document isn't
 * lost. Bounded: the topic is anyone's with the integrations account.
 */
const MAX_PENDING_CAMERAS = 64;

/**
 * Generic MQTT integrations following the GetHome convention
 * (src/adapters/mqtt/convention.ts). Because both directions use the
 * canonical schema, this adapter is also the reference implementation —
 * and the fake device driver used by the integration tests.
 */
export class MqttAdapter implements ProtocolAdapter {
  readonly id = 'mqtt' as const;

  private client: mqtt.MqttClient | null = null;
  private bus: AdapterBus | null = null;
  private readonly known = new Map<string, MqttDiscoveryConfig>();
  /**
   * What each camera announced, by device and endpoint — **in memory only.**
   * The camera topic is retained, so the broker hands every announcement
   * back after a restart, and keeping the addresses out of the database keeps
   * them off the card and out of every backup.
   */
  private readonly cameras = new Map<string, Map<number, CameraStreamSource[]>>();
  /** Devices that said how often they speak, and whether they still do (`heartbeat.ts`). */
  private readonly heartbeats: HeartbeatWatch;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: MqttAdapterOptions) {
    this.heartbeats = new HeartbeatWatch(options.now ?? Date.now);
  }

  async start(bus: AdapterBus): Promise<void> {
    this.bus = bus;
    const client = await mqtt.connectAsync(this.options.mqttUrl, {
      clientId: `gethome-hub-mqtt-${Math.random().toString(16).slice(2, 8)}`,
      reconnectPeriod: 2000,
      ...brokerCredentials(this.options),
    });
    this.client = client;
    client.on('message', (topic, payload, packet) => {
      try {
        this.handleMessage(topic, payload.toString('utf8'), packet.retain);
      } catch (error) {
        this.options.log.warn({ err: error, topic }, 'Failed to handle MQTT integration message');
      }
    });
    // A reconnect means the broker hands every retained message over again —
    // a stale `online` among them, when it was the broker that restarted — so
    // every heartbeat's allowance starts again from it.
    client.on('connect', () => this.heartbeats.restart());
    await client.subscribeAsync(subscriptionPatterns());
    this.sweepTimer = setInterval(() => this.sweepQuiet(), HEARTBEAT_SWEEP_MS);
    this.sweepTimer.unref?.();
    this.options.log.info('MQTT integration adapter listening on gethome/#');
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    await this.client?.endAsync();
    this.client = null;
  }

  async execute(externalId: string, endpointId: number, command: HubCommand): Promise<void> {
    if (!this.client) throw new Error('MQTT adapter is not connected');
    if (!this.known.has(externalId)) throw new Error(`Unknown MQTT device ${externalId}`);
    await this.client.publishAsync(commandTopic(externalId, endpointId), JSON.stringify(command));
  }

  /**
   * Deleted in an app: clear the device's retained discovery document — and
   * its camera and heartbeat topics — so it doesn't come back on the next
   * boot, and so a device listening to its own config topic hears that it was
   * removed.
   *
   * The id leaves `known` **first**: our own subscription hears the empty
   * config a moment later, and finding nothing to remove is what keeps that
   * echo from being a second removal (and a second `device.removed` row).
   */
  async forget(externalId: string): Promise<void> {
    const config = this.known.get(externalId);
    this.known.delete(externalId);
    this.cameras.delete(externalId);
    this.heartbeats.forget(externalId);
    // Not a quiet success: the retained config is what would bring the device
    // back on the next start, and the registry keeps it waiting until it goes.
    if (!this.client) throw new Error('The MQTT adapter is not connected to the broker.');
    const endpointIds = new Set([1, ...(config?.endpoints.map((endpoint) => endpoint.endpointId) ?? [])]);
    const topics = [
      configTopic(externalId),
      heartbeatTopic(externalId),
      ...[...endpointIds].map((id) => cameraTopic(externalId, id)),
    ];
    await Promise.all(topics.map((topic) => this.client!.publishAsync(topic, '', { qos: 1, retain: true })));
  }

  cameraSource(externalId: string, endpointId: number, streamId: string): CameraSource | null {
    if (!this.known.has(externalId)) return null;
    const stream = this.cameras.get(externalId)?.get(endpointId)?.find((candidate) => candidate.id === streamId);
    return stream ? { kind: stream.kind, url: stream.url } : null;
  }

  /**
   * @param retained Whether the broker handed this over from what it holds —
   *   as it does with everything retained when the hub subscribes — rather
   *   than as the device published it. Only a live message is the device
   *   speaking now (`heartbeat.ts`).
   */
  private handleMessage(topic: string, payload: string, retained = false): void {
    const parsed = parseTopic(topic);
    if (!parsed) return;
    const live = !retained;

    switch (parsed.kind) {
      case 'discovery': {
        if (payload.trim() === '') {
          // Empty retained config = the integration removed the device.
          this.heartbeats.forget(parsed.deviceId);
          if (this.known.delete(parsed.deviceId)) {
            this.cameras.delete(parsed.deviceId);
            this.bus?.deviceRemoved('mqtt', parsed.deviceId);
          }
          return;
        }
        const result = mqttDiscoverySchema.safeParse(JSON.parse(payload));
        if (!result.success) {
          this.options.log.warn(
            { deviceId: parsed.deviceId, issues: result.error.issues },
            'Rejected invalid MQTT discovery config',
          );
          this.bus?.activity({
            kind: 'mqtt.invalid',
            message: `Rejected invalid MQTT discovery config for "${parsed.deviceId}".`,
          });
          return;
        }
        this.known.set(parsed.deviceId, result.data);
        this.announce(parsed.deviceId, result.data);
        // A camera that announced itself before its discovery document landed
        // gets its streams now.
        for (const [endpointId, streams] of this.cameras.get(parsed.deviceId) ?? []) {
          this.publishCameraState(parsed.deviceId, endpointId, streams);
        }
        this.noteHeard(parsed.deviceId, live);
        return;
      }

      case 'state': {
        if (!this.known.has(parsed.deviceId)) return;
        const json: unknown = JSON.parse(payload);
        // `camera` is the hub's to write (from the camera topic), never a
        // device's: a device could otherwise put any stream list in front of
        // the apps, without the address checks the camera topic gets.
        if (typeof json === 'object' && json !== null && 'camera' in json) {
          delete (json as { camera?: unknown }).camera;
        }
        const result = statePatchSchema.safeParse(json);
        if (!result.success) {
          // The reasons go in the line, as the discovery refusal's do: a refused
          // state report is explained nowhere else.
          this.options.log.warn(
            { deviceId: parsed.deviceId, endpointId: parsed.endpointId, issues: result.error.issues },
            'Rejected invalid MQTT state payload',
          );
          return;
        }
        // An event without a timestamp gets one on arrival, like the Zigbee
        // and AI paths — integrators shouldn't need a clock to report a press.
        const patch = result.data;
        if (patch.event && (patch.event.action ?? patch.event.gesture ?? patch.event.button) !== undefined) {
          patch.event.at ??= Date.now();
        }
        this.bus?.stateChanged(
          'mqtt',
          parsed.deviceId,
          parsed.endpointId,
          // zod's deep-partial output is structurally a state patch; the cast
          // bridges exactOptionalPropertyTypes.
          patch as Partial<import('../../schema/index.js').EndpointState>,
        );
        this.noteHeard(parsed.deviceId, live);
        return;
      }

      case 'availability': {
        if (!this.known.has(parsed.deviceId)) return;
        const online = payload.trim() === 'online';
        this.bus?.reachabilityChanged('mqtt', parsed.deviceId, online);
        if (online) this.heartbeats.heardFrom(parsed.deviceId, live);
        else this.heartbeats.wentOffline(parsed.deviceId);
        return;
      }

      case 'heartbeat': {
        // Kept for a device the hub hasn't met yet as well: retained messages
        // arrive in whatever order the broker holds them, and the heartbeat
        // can come before the discovery document it belongs to.
        const seconds = readHeartbeat(payload);
        if (seconds === 'withdrawn') {
          this.heartbeats.forget(parsed.deviceId);
          return;
        }
        if (seconds === null) {
          this.options.log.warn({ deviceId: parsed.deviceId }, 'Ignored a heartbeat that is not a whole number of seconds');
          return;
        }
        if (this.heartbeats.declare(parsed.deviceId, seconds, live) && this.known.has(parsed.deviceId)) {
          this.bus?.reachabilityChanged('mqtt', parsed.deviceId, true);
        }
        return;
      }

      case 'camera': {
        this.cameraAnnounced(parsed.deviceId, parsed.endpointId, payload);
        if (this.known.has(parsed.deviceId)) this.noteHeard(parsed.deviceId, live);
        return;
      }
    }
  }

  /**
   * The device published something. Arriving live, from a device its
   * heartbeat had called quiet, it says the device is there after all.
   */
  private noteHeard(deviceId: string, live: boolean): void {
    if (this.heartbeats.heardFrom(deviceId, live) && this.known.has(deviceId)) {
      this.bus?.reachabilityChanged('mqtt', deviceId, true);
    }
  }

  /**
   * A device that said how often it speaks and has been silent well past that
   * is offline, whatever the broker still holds for it — the will it left can
   * have been lost with the broker itself.
   */
  private sweepQuiet(): void {
    for (const deviceId of this.heartbeats.sweep()) {
      if (!this.known.has(deviceId)) continue;
      this.options.log.info({ deviceId }, 'An MQTT device has been silent past its heartbeat; marking it offline.');
      this.bus?.reachabilityChanged('mqtt', deviceId, false);
    }
  }

  /**
   * A camera said what it serves. The streams are read leniently (one this
   * hub can't use is dropped on its own), kept in memory with their
   * addresses, and handed to the registry twice: as the `camera` capability
   * on that endpoint, and as a state patch carrying everything but the
   * addresses. An empty payload withdraws them.
   */
  private cameraAnnounced(deviceId: string, endpointId: number, payload: string): void {
    let streams: CameraStreamSource[] = [];
    if (payload.trim() !== '') {
      let json: unknown;
      try {
        json = JSON.parse(payload);
      } catch {
        this.options.log.warn({ deviceId }, 'Ignored a camera announcement that is not JSON');
        return;
      }
      const read = readCameraAnnouncement(json);
      streams = read.streams;
      if (read.dropped.length > 0) {
        this.options.log.warn({ deviceId, endpointId, dropped: read.dropped }, 'Dropped camera streams the hub will not serve');
      }
    }

    const config = this.known.get(deviceId);
    if (config && !config.endpoints.some((endpoint) => endpoint.endpointId === endpointId)) return;

    const byEndpoint = this.cameras.get(deviceId) ?? new Map<number, CameraStreamSource[]>();
    const had = byEndpoint.has(endpointId);
    if (streams.length > 0) byEndpoint.set(endpointId, streams);
    else byEndpoint.delete(endpointId);
    if (byEndpoint.size > 0) {
      if (!this.cameras.has(deviceId) && !config && this.pendingCameraCount() >= MAX_PENDING_CAMERAS) return;
      this.cameras.set(deviceId, byEndpoint);
    } else {
      this.cameras.delete(deviceId);
    }

    // A device the hub hasn't met yet gets these when its discovery arrives.
    if (!config) return;
    this.announce(deviceId, config);
    if (streams.length > 0 || had) this.publishCameraState(deviceId, endpointId, streams);
  }

  private pendingCameraCount(): number {
    let count = 0;
    for (const deviceId of this.cameras.keys()) if (!this.known.has(deviceId)) count += 1;
    return count;
  }

  private publishCameraState(deviceId: string, endpointId: number, streams: CameraStreamSource[]): void {
    this.bus?.stateChanged('mqtt', deviceId, endpointId, { camera: { streams: streams.map(publicStream) } });
  }

  /**
   * The device as the registry should hold it: what its discovery document
   * declares, plus `camera` on every endpoint that has announced streams.
   */
  private announce(deviceId: string, config: MqttDiscoveryConfig): void {
    const cameras = this.cameras.get(deviceId);
    const descriptor: AdapterDeviceDescriptor = {
      adapter: 'mqtt',
      externalId: deviceId,
      ...(config.vendor ? { vendor: config.vendor } : {}),
      ...(config.model ? { model: config.model } : {}),
      suggestedName: config.name,
      endpoints: config.endpoints.map((endpoint) => {
        const capabilities: CapabilityKind[] = [...endpoint.capabilities];
        if (cameras?.has(endpoint.endpointId)) capabilities.push('camera');
        return {
          endpointId: endpoint.endpointId,
          deviceKind: endpoint.deviceKind,
          capabilities,
          primary: endpoint.primary,
        };
      }),
    };
    this.bus?.deviceUpserted(descriptor);
  }
}
