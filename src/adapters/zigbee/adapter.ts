import mqtt from 'mqtt';
import type { AdapterBus, DeviceRecognition, ProtocolAdapter } from '../adapter.js';
import type { CapabilityKind, DeviceKind, EndpointState, HubCommand } from '../../schema/index.js';
import { UnsupportedCommandError } from '../../schema/index.js';
import {
  exposesHash,
  mapExposes,
  type CustomFieldSpec,
  type Z2mDevice,
  type Z2mProfile,
} from './exposes-mapper.js';
import { buildSetPayload } from './commands.js';
import type { Logger } from '../../logging.js';

/**
 * Hook the AI mapper implements (src/ai/mapper.ts). When the static exposes
 * mapping leaves properties unmapped — at adoption or when a device starts
 * publishing parameters nobody declared — the adapter asks for an
 * AI-generated mapping; a returned mapping overlays the static rules for the
 * endpoints and properties it declares.
 */
export interface ZigbeeAiAssist {
  requestMapping(
    device: Z2mDevice,
    staticProfile: Z2mProfile,
    options?: {
      /** Recent state payloads, newest last, to ground the mapping. */
      samples?: Record<string, unknown>[];
      /** Drop any cached mapping and regenerate. */
      force?: boolean;
    },
  ): Promise<AppliedAiMapping | null>;
}

export interface AppliedAiMapping {
  /** Whether the agent produced this descriptor or somebody uploaded it. */
  source?: 'ai' | 'imported';
  endpoints: Array<{
    endpointId: number;
    deviceKind: DeviceKind;
    capabilities: CapabilityKind[];
    primary: CapabilityKind;
    /** Generic controls the AI declared for this endpoint. */
    customFields?: CustomFieldSpec[];
  }>;
  /** Every payload property the mapping reads (typed rules + custom fields). */
  properties: Set<string>;
  /** Properties mapped onto *typed* capabilities (supersede static fields). */
  typedProperties: Set<string>;
  extractState(payload: Record<string, unknown>): Map<number, Partial<EndpointState>>;
  buildCommandPayload(endpointId: number, command: HubCommand): Record<string, unknown> | null;
}

interface TrackedDevice {
  ieee: string;
  friendlyName: string;
  profile: Z2mProfile;
  /** JSON of the exposes definition, to detect schema changes on re-sync. */
  fingerprint: string;
  aiMapping?: AppliedAiMapping;
  /** Rolling buffer of recent state payloads (newest last, max 3). */
  samples: Record<string, unknown>[];
  /** Unknown payload keys we already asked the AI mapper about. */
  aiAskedKeys: Set<string>;
  remapTimer?: NodeJS.Timeout | undefined;
}

/** A device arriving on, or leaving, the network — from `<base>/bridge/event`. */
export interface Z2mBridgeEvent {
  type?: string;
  data?: {
    friendly_name?: string;
    ieee_address?: string;
    status?: string;
  };
}

/** The join-window fields of `<base>/bridge/info`. `permit_join_end` is epoch
 *  seconds (current Z2M); `permit_join_timeout` is seconds remaining (older). */
export interface Z2mBridgeInfo {
  permit_join?: boolean;
  permit_join_end?: number;
  permit_join_timeout?: number;
}

/** How one pass of `adoptDevice` should treat the device's stored mapping. */
interface AdoptOptions {
  /** First sight: write an activity row and ask the device for a snapshot. */
  announce?: boolean;
  /** Throw the stored mapping away and ask the agent again. */
  regenerate?: boolean;
  /** Consult the library even for a device the static mapper placed fully. */
  consultMapping?: boolean;
}

export interface ZigbeeAdapterOptions {
  mqttUrl: string;
  baseTopic: string;
  log: Logger;
  aiAssist?: ZigbeeAiAssist;
  /** Debounce before a parameter-triggered AI remap (test seam). */
  parameterRemapDelayMs?: number;
  /**
   * Zigbee2MQTT's own account of devices joining and being interviewed. The
   * adapter relays it rather than acting on it: `bridge/devices` is still what
   * adopts a device, and it only lists devices whose interview finished — so
   * without this the whole of pairing, which is the minute a user is actually
   * watching, produced no output at all.
   */
  onBridgeEvent?(event: Z2mBridgeEvent): void;
  /** The bridge's own status, read for the live permit-join window. */
  onBridgeInfo?(info: Z2mBridgeInfo): void;
}

const SAMPLE_BUFFER_SIZE = 3;

/**
 * Zigbee support via Zigbee2MQTT: consumes the retained
 * `<base>/bridge/devices` registry (definitions + exposes), maps devices into
 * the canonical schema (multi-endpoint aware), relays state topics, and
 * publishes `/set` commands. Payload keys that neither the static profile nor
 * the AI mapping understands trigger a one-time, sample-grounded AI remap.
 */
export class ZigbeeAdapter implements ProtocolAdapter {
  readonly id = 'zigbee' as const;

  private client: mqtt.MqttClient | null = null;
  private bus: AdapterBus | null = null;
  private readonly byIeee = new Map<string, TrackedDevice>();
  private readonly byFriendlyName = new Map<string, TrackedDevice>();
  private readonly base: string;
  private bridgeOnline = false;

  constructor(private readonly options: ZigbeeAdapterOptions) {
    this.base = options.baseTopic.replace(/\/+$/, '');
  }

  /**
   * Whether Zigbee2MQTT is actually there, as opposed to the broker being up.
   * The two differ for most of a hub's life: Z2M only runs when a coordinator
   * is plugged in, so "no Zigbee" is the normal state, not a fault, and the
   * apps need to be able to tell that from a broken one.
   */
  get connected(): boolean {
    return this.bridgeOnline;
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
    for (const device of this.byIeee.values()) {
      if (device.remapTimer) clearTimeout(device.remapTimer);
    }
    await this.client?.endAsync();
    this.client = null;
    this.bridgeOnline = false;
  }

  async execute(externalId: string, endpointId: number, command: HubCommand): Promise<void> {
    const device = this.byIeee.get(externalId);
    if (!device) throw new Error(`Unknown Zigbee device ${externalId}`);

    let payload: Record<string, unknown> | null = null;
    if (device.aiMapping) {
      payload = device.aiMapping.buildCommandPayload(endpointId, command);
    }
    if (!payload) {
      const endpoint = device.profile.endpoints.find((candidate) => candidate.endpointId === endpointId);
      if (!endpoint) throw new UnsupportedCommandError(command.type, `no endpoint ${endpointId}`);
      payload = buildSetPayload(command, endpoint.features);
    }
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

  /** Re-run mapping (invalidating any cached AI descriptor) for one device. */
  async remap(externalId: string): Promise<boolean> {
    const raw = this.rawDefinitions.get(externalId);
    if (!raw) return false;
    await this.adoptDevice(raw, { regenerate: true });
    return true;
  }

  /** The bridge entries of every tracked device whose published schema hashes
   *  to `hash` — that is, every device one library entry governs. */
  devicesOfModel(hash: string): Z2mDevice[] {
    return [...this.rawDefinitions.values()].filter((device) => exposesHash(device) === hash);
  }

  /**
   * Re-adopt every device of one model after its stored mapping changed.
   *
   * Distinct from `remap`, which *regenerates* — this applies what is already
   * in the library, which is what an import or a repair has just written.
   * Consulting the mapping is forced because a device the static mapper placed
   * completely would otherwise never ask for it, and somebody who uploaded a
   * mapping for that device plainly wants it used.
   */
  async applyStoredMapping(hash: string): Promise<string[]> {
    const applied: string[] = [];
    for (const device of this.devicesOfModel(hash)) {
      await this.adoptDevice(device, { consultMapping: true });
      applied.push(device.ieee_address);
    }
    return applied;
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
      this.bridgeOnline = state === 'online';
      this.options.log.info(`Zigbee2MQTT is ${state}.`);
      return;
    }
    // Two bridge topics are relayed rather than dropped. `bridge/event` is the
    // only account of a device joining *before* its interview finishes, which
    // is the whole of what the user is watching while they pair something; and
    // `bridge/info` is the coordinator's own word on whether the network is
    // open, which beats any timer the hub keeps for itself.
    if (suffix === 'bridge/event') {
      if (this.options.onBridgeEvent && payload.startsWith('{')) {
        this.options.onBridgeEvent(JSON.parse(payload) as Z2mBridgeEvent);
      }
      return;
    }
    if (suffix === 'bridge/info') {
      if (this.options.onBridgeInfo && payload.startsWith('{')) {
        this.options.onBridgeInfo(JSON.parse(payload) as Z2mBridgeInfo);
      }
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

    device.samples.push(parsed);
    if (device.samples.length > SAMPLE_BUFFER_SIZE) device.samples.shift();

    // Static rules first, then the AI mapping overlays the endpoints and
    // properties it declares (it wins on conflicts).
    const patches = device.profile.extractState(parsed);
    if (device.aiMapping) {
      for (const [endpointId, aiPatch] of device.aiMapping.extractState(parsed)) {
        if (Object.keys(aiPatch).length === 0) continue;
        const existing = patches.get(endpointId);
        patches.set(endpointId, existing ? mergePatches(existing, aiPatch) : aiPatch);
      }
    }
    for (const [endpointId, patch] of patches) {
      if (Object.keys(patch).length > 0) {
        this.bus?.stateChanged('zigbee', device.ieee, endpointId, patch);
      }
    }

    this.detectUnknownParameters(device, parsed);
  }

  /**
   * A payload key nobody declared (not in the exposes, not AI-mapped) is a
   * new parameter — the "we can't interpret this yet" case. Ask the AI
   * mapper once per key, debounced so a burst of reports produces one
   * request grounded in fresh samples.
   */
  private detectUnknownParameters(device: TrackedDevice, payload: Record<string, unknown>): void {
    if (!this.options.aiAssist) return;
    const newKeys = Object.keys(payload).filter(
      (key) =>
        !device.profile.knownProperties.has(key) &&
        !(device.aiMapping?.properties.has(key) ?? false) &&
        !device.aiAskedKeys.has(key),
    );
    if (newKeys.length === 0) return;
    for (const key of newKeys) device.aiAskedKeys.add(key);
    this.options.log.info(
      `${device.friendlyName} published unknown parameter(s) ${newKeys.join(', ')} — scheduling an AI remap.`,
    );
    if (device.remapTimer) return;
    const timer = setTimeout(() => {
      device.remapTimer = undefined;
      const raw = this.rawDefinitions.get(device.ieee);
      if (!raw) return;
      void this.adoptDevice(raw, { regenerate: true }).catch((error) => {
        this.options.log.warn({ err: error }, `Parameter remap failed for ${device.friendlyName}`);
      });
    }, this.options.parameterRemapDelayMs ?? 5000);
    timer.unref?.();
    device.remapTimer = timer;
  }

  private async syncDevices(devices: Z2mDevice[]): Promise<void> {
    const seen = new Set<string>();
    for (const device of devices) {
      if (device.type === 'Coordinator' || device.disabled) continue;
      if (!interviewFinished(device)) continue;
      seen.add(device.ieee_address);
      this.rawDefinitions.set(device.ieee_address, device);
      const known = this.byIeee.get(device.ieee_address);
      const fingerprint = JSON.stringify(device.definition?.exposes ?? []);
      if (!known || known.friendlyName !== device.friendly_name || known.fingerprint !== fingerprint) {
        await this.adoptDevice(device, { announce: !known });
      }
    }
    // Devices no longer in the bridge registry were removed from the network.
    for (const [ieee, tracked] of this.byIeee) {
      if (!seen.has(ieee)) {
        if (tracked.remapTimer) clearTimeout(tracked.remapTimer);
        this.byIeee.delete(ieee);
        this.byFriendlyName.delete(tracked.friendlyName);
        this.rawDefinitions.delete(ieee);
        this.bus?.deviceRemoved('zigbee', ieee);
      }
    }
  }

  private async adoptDevice(device: Z2mDevice, options: AdoptOptions = {}): Promise<void> {
    const { announce = false, regenerate = false, consultMapping = false } = options;
    const raw = this.rawDefinitions.get(device.ieee_address) ?? device;
    const profile = mapExposes(raw);
    const previous = this.byIeee.get(raw.ieee_address);
    const tracked: TrackedDevice = {
      ieee: raw.ieee_address,
      friendlyName: raw.friendly_name,
      profile,
      fingerprint: JSON.stringify(raw.definition?.exposes ?? []),
      samples: previous?.samples ?? [],
      aiAskedKeys: previous?.aiAskedKeys ?? new Set(),
    };
    if (previous?.remapTimer) clearTimeout(previous.remapTimer);

    // Ask the AI mapper when a property has NO representation at all
    // (uncovered — composites, or a device Z2M barely supports), when nothing
    // mapped, or on an explicit remap. Properties that got a generic custom
    // field are already controllable, so they don't auto-trigger the AI; a
    // remap can still upgrade them to typed capabilities.
    const staticallyEmpty = profile.endpoints.every((endpoint) => endpoint.capabilities.length === 0);
    const needsHelp =
      regenerate ||
      consultMapping ||
      raw.supported === false ||
      staticallyEmpty ||
      profile.uncovered.length > 0;
    if (needsHelp && this.options.aiAssist) {
      try {
        const mapping = await this.options.aiAssist.requestMapping(raw, profile, {
          samples: tracked.samples,
          ...(regenerate ? { force: true } : {}),
        });
        if (mapping) tracked.aiMapping = mapping;
      } catch (error) {
        this.options.log.warn({ err: error }, `AI mapping failed for ${raw.friendly_name}`);
      }
    }

    // Replace under both keys (friendly name may have changed).
    if (previous) this.byFriendlyName.delete(previous.friendlyName);
    this.byIeee.set(raw.ieee_address, tracked);
    this.byFriendlyName.set(raw.friendly_name, tracked);

    this.bus?.deviceUpserted({
      adapter: 'zigbee',
      externalId: raw.ieee_address,
      ...(raw.definition?.vendor ? { vendor: raw.definition.vendor } : {}),
      ...(raw.definition?.model ? { model: raw.definition.model } : {}),
      suggestedName: suggestedNameFor(raw),
      endpoints: mergedEndpoints(tracked),
      needsReview: needsReview(tracked),
      recognition: recognitionOf(tracked, exposesHash(raw)),
    });

    // Seed the button inventory so the apps can render remotes before (and
    // regardless of) the first press.
    for (const endpoint of profile.endpoints) {
      if (endpoint.buttons && endpoint.buttons.length > 0) {
        this.bus?.stateChanged('zigbee', raw.ieee_address, endpoint.endpointId, {
          event: { buttons: endpoint.buttons },
        });
      }
    }

    // Seed the custom-field inventory: the static fields (minus any the AI
    // superseded with typed mappings or its own fields) plus the AI's fields.
    for (const [endpointId, fields] of mergedCustomFields(tracked)) {
      this.bus?.stateChanged('zigbee', raw.ieee_address, endpointId, {
        custom: { fields },
      });
    }

    if (announce) {
      this.bus?.activity({
        kind: 'zigbee.joined',
        message: `${raw.friendly_name} joined over Zigbee.`,
        adapter: 'zigbee',
        externalId: raw.ieee_address,
      });
      // Ask the device for a fresh snapshot of its readable controls.
      const get: Record<string, string> = {};
      for (const endpoint of profile.endpoints) {
        if (endpoint.features.hasOnOff && endpoint.features.stateProperty) {
          get[endpoint.features.stateProperty] = '';
        }
        if (endpoint.features.hasPosition && endpoint.features.positionProperty) {
          get[endpoint.features.positionProperty] = '';
        }
      }
      if (Object.keys(get).length > 0) {
        await this.publish(`${this.base}/${raw.friendly_name}/get`, JSON.stringify(get)).catch(() => {});
      }
    }
  }

  private async publish(topic: string, payload: string): Promise<void> {
    if (!this.client) throw new Error('Zigbee adapter is not connected');
    await this.client.publishAsync(topic, payload);
  }
}

/**
 * The endpoints announced to the registry: static endpoints with the AI
 * mapping's endpoints overlaid — the AI's kind/primary win where both exist,
 * capabilities are the union, and AI-only endpoints are appended.
 */
function mergedEndpoints(tracked: TrackedDevice): Array<{
  endpointId: number;
  deviceKind: DeviceKind;
  capabilities: CapabilityKind[];
  primary: CapabilityKind;
}> {
  const merged = new Map<
    number,
    { endpointId: number; deviceKind: DeviceKind; capabilities: CapabilityKind[]; primary: CapabilityKind }
  >();
  for (const endpoint of tracked.profile.endpoints) {
    merged.set(endpoint.endpointId, {
      endpointId: endpoint.endpointId,
      deviceKind: endpoint.kind,
      capabilities: [...endpoint.capabilities],
      primary: endpoint.primary,
    });
  }
  for (const endpoint of tracked.aiMapping?.endpoints ?? []) {
    const existing = merged.get(endpoint.endpointId);
    if (!existing) {
      merged.set(endpoint.endpointId, {
        endpointId: endpoint.endpointId,
        deviceKind: endpoint.deviceKind,
        capabilities: [...endpoint.capabilities],
        primary: endpoint.primary,
      });
      continue;
    }
    existing.deviceKind = endpoint.deviceKind;
    existing.primary = endpoint.primary;
    for (const capability of endpoint.capabilities) {
      if (!existing.capabilities.includes(capability)) existing.capabilities.push(capability);
    }
  }
  return [...merged.values()]
    .sort((a, b) => a.endpointId - b.endpointId)
    .filter((endpoint) => endpoint.capabilities.length > 0);
}

/**
 * Merge two patches for the same endpoint, sub-object by sub-object, so an
 * AI patch writing `sensors.humidityCenti` doesn't clobber the static rule's
 * `sensors.temperatureCenti` from the same payload. The overlay wins on
 * conflicting scalars.
 */
function mergePatches(base: Partial<EndpointState>, overlay: Partial<EndpointState>): Partial<EndpointState> {
  const out = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(overlay)) {
    const existing = out[key];
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      out[key] = { ...existing, ...value };
    } else {
      out[key] = value;
    }
  }
  return out as Partial<EndpointState>;
}

/**
 * The custom-field inventories to seed, per endpoint: static fields whose
 * property the AI didn't claim (typed mapping or its own field wins), plus
 * the AI's declared fields.
 */
function mergedCustomFields(tracked: TrackedDevice): Map<number, CustomFieldSpec[]> {
  const result = new Map<number, CustomFieldSpec[]>();
  const aiClaimed = new Set<string>();
  for (const endpoint of tracked.aiMapping?.endpoints ?? []) {
    for (const field of endpoint.customFields ?? []) aiClaimed.add(field.id);
  }
  for (const property of tracked.aiMapping?.typedProperties ?? []) aiClaimed.add(property);

  for (const endpoint of tracked.profile.endpoints) {
    const statics = (endpoint.customFields ?? []).filter((field) => !aiClaimed.has(field.id));
    if (statics.length > 0) result.set(endpoint.endpointId, statics);
  }
  for (const endpoint of tracked.aiMapping?.endpoints ?? []) {
    if (!endpoint.customFields || endpoint.customFields.length === 0) continue;
    const existing = result.get(endpoint.endpointId) ?? [];
    result.set(endpoint.endpointId, [...existing, ...endpoint.customFields].slice(0, 32));
  }
  return result;
}

/**
 * Whether Zigbee2MQTT has finished interviewing a device, across both of the
 * fields it has used to say so.
 *
 * Zigbee2MQTT 2.x replaced the boolean `interview_completed` with the
 * four-valued `interview_state`, and a version that publishes only the new
 * field left the old check reading `undefined === false` — false — so a device
 * still being interviewed was adopted as if it were ready, with whatever
 * partial `definition` the bridge had at that instant. Absence of both fields
 * stays "finished": that is what every version published for a device it was
 * done with, and refusing an unrecognised shape would adopt nothing at all.
 */
function interviewFinished(device: Z2mDevice): boolean {
  if (device.interview_state !== undefined) {
    return device.interview_state.toUpperCase() === 'SUCCESSFUL';
  }
  return device.interview_completed !== false;
}

/**
 * What to call a device the first time it is seen.
 *
 * Zigbee2MQTT names a newly joined device **after its own address** — a device
 * is `friendly_name: "0x54ef44100047c1bf"` until somebody opens Z2M's frontend
 * and renames it there. Passing that straight through put an eighteen-character
 * hex string on the tile in the GetHome app, which reads as a hub that failed
 * to recognise the device. It hadn't: the same record carries a full `exposes`
 * schema, a vendor, a model and upstream's own one-line description, and every
 * one of them had been mapped correctly.
 *
 * So the description is the name — "Smart plug EU", not "Outlet", because the
 * device *kind* is already a line of its own on the tile and repeating it says
 * nothing about which plug this is. The short address rides along because two
 * units of one model would otherwise be two identical rows with no way to tell
 * them apart; four hex digits is the least that distinguishes them, and it is
 * the same tail Zigbee2MQTT and the sticker show.
 *
 * A name somebody has actually chosen always wins, in either place: Z2M's, when
 * it is not just the address, and the owner's, because the registry writes this
 * on the insert only and never over an existing row.
 */
export function suggestedNameFor(device: Z2mDevice): string {
  const chosen = device.friendly_name?.trim();
  if (chosen && chosen.toLowerCase() !== device.ieee_address.toLowerCase()) return chosen;

  const described = device.definition?.description?.trim();
  const madeBy = [device.definition?.vendor, device.definition?.model]
    .map((part) => part?.trim())
    .filter((part): part is string => !!part)
    .join(' ');
  const base = described || madeBy;
  if (!base) return chosen || device.ieee_address;
  return `${base} ${device.ieee_address.replace(/^0x/i, '').slice(-4).toUpperCase()}`;
}

/**
 * Review is needed only while some property has NO representation at all —
 * no typed mapping, no custom field, not AI-covered.
 */
function needsReview(tracked: TrackedDevice): boolean {
  if (leftoverProperties(tracked).length > 0) return true;
  return mergedEndpoints(tracked).length === 0;
}

/** Properties still with no representation after every layer that ran. */
function leftoverProperties(tracked: TrackedDevice): string[] {
  const aiProperties = tracked.aiMapping?.properties;
  return tracked.profile.uncovered.filter((property) => !(aiProperties?.has(property) ?? false));
}

/**
 * How this device was placed, for the apps to report.
 *
 * `source` is the *highest layer that was needed*, not every layer that ran:
 * almost every device uses typed capabilities, so saying so about all of them
 * would carry no information. What a reader wants to know is whether this one
 * cost an agent run — and, when it didn't, whether it is fully typed or is
 * only reachable through generic controls.
 */
function recognitionOf(tracked: TrackedDevice, hash: string): DeviceRecognition {
  const aiTyped = tracked.aiMapping?.typedProperties;
  const source: DeviceRecognition['source'] = tracked.aiMapping
    ? (tracked.aiMapping.source ?? 'ai')
    : mergedEndpoints(tracked).length === 0
      ? 'none'
      : tracked.profile.unmapped.length > 0
        ? 'custom-fields'
        : 'static';
  return {
    source,
    uncovered: leftoverProperties(tracked),
    unmapped: tracked.profile.unmapped.filter((property) => !(aiTyped?.has(property) ?? false)),
    exposesHash: hash,
  };
}
