import mqtt from 'mqtt';
import type { AdapterBus, ProtocolAdapter } from '../adapter.js';
import type { EndpointState, HubCommand } from '../../schema/index.js';
import { UnsupportedCommandError } from '../../schema/index.js';
import { mapExposes, type Z2mDevice, type Z2mProfile } from './exposes-mapper.js';
import { buildSetPayload } from './commands.js';
import type { Logger } from '../../logging.js';

/**
 * Hook the AI mapper implements (src/ai/mapper.ts). When the static exposes
 * mapping is empty or partial, the adapter asks for an AI-generated mapping;
 * a returned mapping overrides state extraction and command translation for
 * the endpoints it declares.
 */
export interface ZigbeeAiAssist {
  requestMapping(device: Z2mDevice, staticProfile: Z2mProfile): Promise<AppliedAiMapping | null>;
}

export interface AppliedAiMapping {
  endpoints: Array<{
    endpointId: number;
    deviceKind: Z2mProfile['kind'];
    capabilities: Z2mProfile['capabilities'];
    primary: Z2mProfile['primary'];
  }>;
  extractState(payload: Record<string, unknown>): Map<number, Partial<EndpointState>>;
  buildCommandPayload(endpointId: number, command: HubCommand): Record<string, unknown> | null;
}

interface TrackedDevice {
  ieee: string;
  friendlyName: string;
  profile: Z2mProfile;
  aiMapping?: AppliedAiMapping;
}

export interface ZigbeeAdapterOptions {
  mqttUrl: string;
  baseTopic: string;
  log: Logger;
  aiAssist?: ZigbeeAiAssist;
}

/**
 * Zigbee support via Zigbee2MQTT: consumes the retained
 * `<base>/bridge/devices` registry (definitions + exposes), maps devices into
 * the canonical schema, relays state topics, and publishes `/set` commands.
 */
export class ZigbeeAdapter implements ProtocolAdapter {
  readonly id = 'zigbee' as const;

  private client: mqtt.MqttClient | null = null;
  private bus: AdapterBus | null = null;
  private readonly byIeee = new Map<string, TrackedDevice>();
  private readonly byFriendlyName = new Map<string, TrackedDevice>();
  private readonly base: string;

  constructor(private readonly options: ZigbeeAdapterOptions) {
    this.base = options.baseTopic.replace(/\/+$/, '');
  }

  async start(bus: AdapterBus): Promise<void> {
    this.bus = bus;
    const client = await mqtt.connectAsync(this.options.mqttUrl, {
      clientId: `gethome-hub-zigbee-${Math.random().toString(16).slice(2, 8)}`,
      reconnectPeriod: 2000,
    });
    this.client = client;
    client.on('message', (topic, payload) => {
      try {
        this.handleMessage(topic, payload.toString('utf8'));
      } catch (error) {
        this.options.log.warn({ err: error, topic }, 'Failed to handle Zigbee2MQTT message');
      }
    });
    await client.subscribeAsync([`${this.base}/#`]);
    this.options.log.info(`Zigbee adapter subscribed to ${this.base}/#`);
  }

  async stop(): Promise<void> {
    await this.client?.endAsync();
    this.client = null;
  }

  async execute(externalId: string, endpointId: number, command: HubCommand): Promise<void> {
    const device = this.byIeee.get(externalId);
    if (!device) throw new Error(`Unknown Zigbee device ${externalId}`);

    let payload: Record<string, unknown> | null = null;
    if (device.aiMapping) {
      payload = device.aiMapping.buildCommandPayload(endpointId, command);
    }
    payload ??= buildSetPayload(command, device.profile.features);
    if (!payload) throw new UnsupportedCommandError(command.type);
    await this.publish(`${this.base}/${device.friendlyName}/set`, JSON.stringify(payload));
  }

  async forget(externalId: string): Promise<void> {
    const device = this.byIeee.get(externalId);
    if (!device) return;
    await this.publish(
      `${this.base}/bridge/request/device/remove`,
      JSON.stringify({ id: device.friendlyName }),
    );
  }

  /** Open (or close, with 0) the network for joining, in seconds. */
  async permitJoin(seconds: number): Promise<void> {
    await this.publish(
      `${this.base}/bridge/request/permit_join`,
      JSON.stringify({ time: Math.max(0, Math.min(254, seconds)) }),
    );
  }

  /** Re-run mapping (including the AI path) for one device. */
  async remap(externalId: string): Promise<boolean> {
    const raw = this.rawDefinitions.get(externalId);
    if (!raw) return false;
    await this.adoptDevice(raw, false);
    return true;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** Keep raw bridge entries so remap can re-run the full pipeline. */
  private readonly rawDefinitions = new Map<string, Z2mDevice>();

  private handleMessage(topic: string, payload: string): void {
    if (!topic.startsWith(`${this.base}/`)) return;
    const suffix = topic.slice(this.base.length + 1);

    if (suffix === 'bridge/devices') {
      const devices = JSON.parse(payload) as Z2mDevice[];
      void this.syncDevices(devices);
      return;
    }
    if (suffix === 'bridge/state') {
      const state = payload.startsWith('{') ? (JSON.parse(payload) as { state?: string }).state : payload;
      this.options.log.info(`Zigbee2MQTT is ${state}.`);
      return;
    }
    if (suffix.startsWith('bridge/')) return;

    if (suffix.endsWith('/availability')) {
      const friendlyName = suffix.slice(0, -'/availability'.length);
      const device = this.byFriendlyName.get(friendlyName);
      if (!device) return;
      const state = payload.startsWith('{') ? (JSON.parse(payload) as { state?: string }).state : payload;
      this.bus?.reachabilityChanged('zigbee', device.ieee, state === 'online');
      return;
    }

    // Plain `<base>/<friendly_name>` topics carry state payloads.
    const device = this.byFriendlyName.get(suffix);
    if (!device || !payload.startsWith('{')) return;
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    if (device.aiMapping) {
      for (const [endpointId, patch] of device.aiMapping.extractState(parsed)) {
        if (Object.keys(patch).length > 0) {
          this.bus?.stateChanged('zigbee', device.ieee, endpointId, patch);
        }
      }
      return;
    }
    const patch = device.profile.extractState(parsed);
    if (Object.keys(patch).length > 0) {
      this.bus?.stateChanged('zigbee', device.ieee, 1, patch);
    }
  }

  private async syncDevices(devices: Z2mDevice[]): Promise<void> {
    const seen = new Set<string>();
    for (const device of devices) {
      if (device.type === 'Coordinator' || device.disabled) continue;
      if (device.interview_completed === false) continue;
      seen.add(device.ieee_address);
      this.rawDefinitions.set(device.ieee_address, device);
      const known = this.byIeee.get(device.ieee_address);
      if (!known || known.friendlyName !== device.friendly_name) {
        await this.adoptDevice(device, !known);
      }
    }
    // Devices no longer in the bridge registry were removed from the network.
    for (const [ieee, tracked] of this.byIeee) {
      if (!seen.has(ieee)) {
        this.byIeee.delete(ieee);
        this.byFriendlyName.delete(tracked.friendlyName);
        this.rawDefinitions.delete(ieee);
        this.bus?.deviceRemoved('zigbee', ieee);
      }
    }
  }

  private async adoptDevice(device: Z2mDevice, announce: boolean): Promise<void> {
    const raw = this.rawDefinitions.get(device.ieee_address) ?? device;
    const profile = mapExposes(raw);
    const tracked: TrackedDevice = {
      ieee: raw.ieee_address,
      friendlyName: raw.friendly_name,
      profile,
    };

    // Ask the AI mapper when static mapping found nothing, when meaningful
    // exposes were left over, or when Z2M itself doesn't know the device.
    const needsHelp =
      raw.supported === false || profile.capabilities.length === 0 || profile.unmapped.length > 0;
    if (needsHelp && this.options.aiAssist) {
      try {
        const mapping = await this.options.aiAssist.requestMapping(raw, profile);
        if (mapping) tracked.aiMapping = mapping;
      } catch (error) {
        this.options.log.warn({ err: error }, `AI mapping failed for ${raw.friendly_name}`);
      }
    }

    // Replace under both keys (friendly name may have changed).
    const previous = this.byIeee.get(raw.ieee_address);
    if (previous) this.byFriendlyName.delete(previous.friendlyName);
    this.byIeee.set(raw.ieee_address, tracked);
    this.byFriendlyName.set(raw.friendly_name, tracked);

    const endpoints = tracked.aiMapping?.endpoints ?? [
      {
        endpointId: 1,
        deviceKind: profile.kind,
        capabilities: profile.capabilities,
        primary: profile.primary,
      },
    ];
    const stillUnmapped = !tracked.aiMapping && (profile.unmapped.length > 0 || profile.capabilities.length === 0);
    this.bus?.deviceUpserted({
      adapter: 'zigbee',
      externalId: raw.ieee_address,
      ...(raw.definition?.vendor ? { vendor: raw.definition.vendor } : {}),
      ...(raw.definition?.model ? { model: raw.definition.model } : {}),
      suggestedName: raw.friendly_name,
      endpoints: endpoints.filter((endpoint) => endpoint.capabilities.length > 0),
      needsReview: stillUnmapped,
    });
    if (announce) {
      this.bus?.activity({
        kind: 'zigbee.joined',
        message: `${raw.friendly_name} joined over Zigbee.`,
        adapter: 'zigbee',
        externalId: raw.ieee_address,
      });
    }

    // Ask the device for a fresh state snapshot where supported.
    if (announce && profile.features.hasOnOff) {
      await this.publish(`${this.base}/${raw.friendly_name}/get`, JSON.stringify({ state: '' })).catch(
        () => {},
      );
    }
  }

  private async publish(topic: string, payload: string): Promise<void> {
    if (!this.client) throw new Error('Zigbee adapter is not connected');
    await this.client.publishAsync(topic, payload);
  }
}
