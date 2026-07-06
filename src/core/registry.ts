import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { devices, endpoints } from '../db/schema.js';
import type {
  AdapterBus,
  AdapterDeviceDescriptor,
  AdapterId,
  ProtocolAdapter,
} from '../adapters/adapter.js';
import {
  emptyState,
  mergeState,
  type CapabilityKind,
  type DeviceKind,
  type EndpointState,
  type HubCommand,
} from '../schema/index.js';
import type { HubEventBus } from './bus.js';
import type { ActivityService } from './activity.js';
import type { Logger } from '../logging.js';

export interface RegistryDevice {
  id: string;
  adapter: AdapterId;
  externalId: string;
  vendor: string | null;
  model: string | null;
  name: string;
  roomId: string | null;
  favorite: boolean;
  online: boolean;
  needsReview: boolean;
  endpoints: RegistryEndpoint[];
}

export interface RegistryEndpoint {
  endpointId: number;
  deviceKind: DeviceKind;
  capabilities: CapabilityKind[];
  primary: CapabilityKind;
  state: EndpointState;
}

/**
 * The hub's device book-keeper. Implements the `AdapterBus` the protocol
 * adapters talk to: persists discovered devices, merges state reports (with
 * an in-memory write-through cache), fans events out to the WebSocket layer,
 * and routes commands back to the owning adapter.
 */
export class DeviceRegistry implements AdapterBus {
  private readonly adapters = new Map<AdapterId, ProtocolAdapter>();
  /** Write-through cache: `${adapter}:${externalId}` → device row + state. */
  private readonly cache = new Map<string, RegistryDevice>();
  private readonly queue = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Db,
    private readonly events: HubEventBus,
    private readonly activityLog: ActivityService,
    private readonly log: Logger,
  ) {}

  registerAdapter(adapter: ProtocolAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  adapter(id: AdapterId): ProtocolAdapter | undefined {
    return this.adapters.get(id);
  }

  /** Load persisted devices into the cache, then start every adapter. */
  async start(): Promise<void> {
    const rows = await this.db.query.devices.findMany();
    for (const row of rows) {
      const endpointRows = await this.db.query.endpoints.findMany({
        where: eq(endpoints.deviceId, row.id),
      });
      this.cache.set(this.key(row.adapter as AdapterId, row.externalId), {
        id: row.id,
        adapter: row.adapter as AdapterId,
        externalId: row.externalId,
        vendor: row.vendor,
        model: row.model,
        name: row.name,
        roomId: row.roomId,
        favorite: row.favorite,
        online: row.online,
        needsReview: row.needsReview,
        endpoints: endpointRows.map((endpoint) => ({
          endpointId: endpoint.endpointId,
          deviceKind: endpoint.deviceKind as DeviceKind,
          capabilities: endpoint.capabilities as CapabilityKind[],
          primary: endpoint.primaryCapability as CapabilityKind,
          state: endpoint.state as EndpointState,
        })),
      });
    }
    this.log.info(`Device registry loaded ${this.cache.size} device(s).`);

    for (const adapter of this.adapters.values()) {
      try {
        await adapter.start(this);
        this.log.info(`Adapter "${adapter.id}" started.`);
      } catch (error) {
        // Adapter failures are isolated: the hub keeps running with the rest.
        this.log.error({ err: error }, `Adapter "${adapter.id}" failed to start — continuing without it.`);
        void this.activityLog.record({
          kind: 'adapter.error',
          message: `The ${adapter.id} adapter failed to start.`,
        });
      }
    }
  }

  async stop(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.stop().catch(() => {});
    }
  }

  // ── AdapterBus ────────────────────────────────────────────────────────────

  deviceUpserted(descriptor: AdapterDeviceDescriptor): void {
    this.enqueue(this.key(descriptor.adapter, descriptor.externalId), async () => {
      const existing = this.cache.get(this.key(descriptor.adapter, descriptor.externalId));
      if (!existing) {
        await this.insertDevice(descriptor);
      } else {
        await this.updateDeviceStructure(existing, descriptor);
      }
    });
  }

  deviceRemoved(adapter: AdapterId, externalId: string): void {
    this.enqueue(this.key(adapter, externalId), async () => {
      const cached = this.cache.get(this.key(adapter, externalId));
      if (!cached) return;
      this.cache.delete(this.key(adapter, externalId));
      await this.db.delete(devices).where(eq(devices.id, cached.id));
      this.events.emit('deviceRemoved', cached.id);
      await this.activityLog.record({
        kind: 'device.removed',
        message: `${cached.name} was removed.`,
      });
    });
  }

  stateChanged(
    adapter: AdapterId,
    externalId: string,
    endpointId: number,
    patch: Partial<EndpointState>,
  ): void {
    this.enqueue(this.key(adapter, externalId), async () => {
      const cached = this.cache.get(this.key(adapter, externalId));
      if (!cached) return;
      const endpoint = cached.endpoints.find((candidate) => candidate.endpointId === endpointId);
      if (!endpoint) return;
      endpoint.state = mergeState(endpoint.state, patch);
      await this.db
        .update(endpoints)
        .set({ state: endpoint.state, updatedAt: new Date() })
        .where(and(eq(endpoints.deviceId, cached.id), eq(endpoints.endpointId, endpointId)));
      this.events.emit('stateChanged', cached.id, endpointId, endpoint.state);
    });
  }

  reachabilityChanged(adapter: AdapterId, externalId: string, reachable: boolean): void {
    this.enqueue(this.key(adapter, externalId), async () => {
      const cached = this.cache.get(this.key(adapter, externalId));
      if (!cached || cached.online === reachable) return;
      cached.online = reachable;
      for (const endpoint of cached.endpoints) {
        endpoint.state = mergeState(endpoint.state, { reachable });
      }
      await this.db.update(devices).set({ online: reachable }).where(eq(devices.id, cached.id));
      this.events.emit('deviceUpserted', cached.id);
    });
  }

  activity(entry: { kind: string; message: string; externalId?: string; adapter?: AdapterId }): void {
    const deviceId =
      entry.adapter && entry.externalId
        ? this.cache.get(this.key(entry.adapter, entry.externalId))?.id
        : undefined;
    void this.activityLog.record({
      kind: entry.kind,
      message: entry.message,
      ...(deviceId ? { deviceId } : {}),
    });
  }

  // ── Queries & commands (used by the API layer) ────────────────────────────

  listDevices(): RegistryDevice[] {
    return [...this.cache.values()];
  }

  getDevice(deviceId: string): RegistryDevice | undefined {
    for (const device of this.cache.values()) {
      if (device.id === deviceId) return device;
    }
    return undefined;
  }

  async execute(deviceId: string, endpointId: number, command: HubCommand): Promise<void> {
    const device = this.getDevice(deviceId);
    if (!device) throw new Error(`Unknown device ${deviceId}`);
    const adapter = this.adapters.get(device.adapter);
    if (!adapter) throw new Error(`Adapter "${device.adapter}" is not running`);
    await adapter.execute(device.externalId, endpointId, command);
  }

  async updateDevice(
    deviceId: string,
    fields: { name?: string; roomId?: string | null; favorite?: boolean },
  ): Promise<RegistryDevice | undefined> {
    const device = this.getDevice(deviceId);
    if (!device) return undefined;
    if (fields.name !== undefined) device.name = fields.name;
    if (fields.roomId !== undefined) device.roomId = fields.roomId;
    if (fields.favorite !== undefined) device.favorite = fields.favorite;
    await this.db
      .update(devices)
      .set({
        ...(fields.name !== undefined ? { name: fields.name } : {}),
        ...(fields.roomId !== undefined ? { roomId: fields.roomId } : {}),
        ...(fields.favorite !== undefined ? { favorite: fields.favorite } : {}),
      })
      .where(eq(devices.id, deviceId));
    this.events.emit('deviceUpserted', deviceId);
    return device;
  }

  async removeDevice(deviceId: string): Promise<boolean> {
    const device = this.getDevice(deviceId);
    if (!device) return false;
    const adapter = this.adapters.get(device.adapter);
    if (adapter?.forget) {
      await adapter.forget(device.externalId).catch((error) => {
        this.log.warn({ err: error }, `Adapter "${device.adapter}" could not forget ${device.externalId}.`);
      });
    }
    this.deviceRemoved(device.adapter, device.externalId);
    await this.flush(this.key(device.adapter, device.externalId));
    return true;
  }

  /** Await all pending writes for a device — used by tests and shutdown. */
  async flush(key?: string): Promise<void> {
    if (key) {
      await this.queue.get(key);
      return;
    }
    await Promise.all([...this.queue.values()]);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private key(adapter: AdapterId, externalId: string): string {
    return `${adapter}:${externalId}`;
  }

  /** Serialize writes per device so adapter events can't interleave. */
  private enqueue(key: string, work: () => Promise<void>): void {
    const previous = this.queue.get(key) ?? Promise.resolve();
    const next = previous
      .then(work)
      .catch((error) => this.log.error({ err: error }, 'Registry write failed'));
    this.queue.set(key, next);
    void next.finally(() => {
      if (this.queue.get(key) === next) this.queue.delete(key);
    });
  }

  private async insertDevice(descriptor: AdapterDeviceDescriptor): Promise<void> {
    const name = descriptor.suggestedName ?? descriptor.model ?? `New ${descriptor.adapter} device`;
    const [row] = await this.db
      .insert(devices)
      .values({
        adapter: descriptor.adapter,
        externalId: descriptor.externalId,
        vendor: descriptor.vendor ?? null,
        model: descriptor.model ?? null,
        name,
        needsReview: descriptor.needsReview ?? false,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) return;
    const device: RegistryDevice = {
      id: row.id,
      adapter: descriptor.adapter,
      externalId: descriptor.externalId,
      vendor: row.vendor,
      model: row.model,
      name: row.name,
      roomId: row.roomId,
      favorite: row.favorite,
      online: row.online,
      needsReview: row.needsReview,
      endpoints: [],
    };
    for (const endpoint of descriptor.endpoints) {
      const state = emptyState();
      await this.db.insert(endpoints).values({
        deviceId: row.id,
        endpointId: endpoint.endpointId,
        deviceKind: endpoint.deviceKind,
        capabilities: endpoint.capabilities,
        primaryCapability: endpoint.primary,
        state,
      });
      device.endpoints.push({
        endpointId: endpoint.endpointId,
        deviceKind: endpoint.deviceKind,
        capabilities: endpoint.capabilities,
        primary: endpoint.primary,
        state,
      });
    }
    this.cache.set(this.key(descriptor.adapter, descriptor.externalId), device);
    this.events.emit('deviceUpserted', device.id);
    await this.activityLog.record({
      kind: 'device.added',
      message: `${device.name} joined the home.`,
      deviceId: device.id,
    });
  }

  /**
   * A re-announcement: update vendor/model/needsReview and reconcile the
   * endpoint structure (capabilities may improve after an AI remap), but
   * never overwrite the user-chosen name.
   */
  private async updateDeviceStructure(
    device: RegistryDevice,
    descriptor: AdapterDeviceDescriptor,
  ): Promise<void> {
    device.vendor = descriptor.vendor ?? device.vendor;
    device.model = descriptor.model ?? device.model;
    device.needsReview = descriptor.needsReview ?? false;
    await this.db
      .update(devices)
      .set({ vendor: device.vendor, model: device.model, needsReview: device.needsReview })
      .where(eq(devices.id, device.id));

    for (const incoming of descriptor.endpoints) {
      const existing = device.endpoints.find((candidate) => candidate.endpointId === incoming.endpointId);
      if (!existing) {
        const state = emptyState();
        await this.db.insert(endpoints).values({
          deviceId: device.id,
          endpointId: incoming.endpointId,
          deviceKind: incoming.deviceKind,
          capabilities: incoming.capabilities,
          primaryCapability: incoming.primary,
          state,
        });
        device.endpoints.push({ ...incoming, state });
      } else if (
        existing.deviceKind !== incoming.deviceKind ||
        existing.primary !== incoming.primary ||
        JSON.stringify(existing.capabilities) !== JSON.stringify(incoming.capabilities)
      ) {
        existing.deviceKind = incoming.deviceKind;
        existing.capabilities = incoming.capabilities;
        existing.primary = incoming.primary;
        await this.db
          .update(endpoints)
          .set({
            deviceKind: incoming.deviceKind,
            capabilities: incoming.capabilities,
            primaryCapability: incoming.primary,
          })
          .where(and(eq(endpoints.deviceId, device.id), eq(endpoints.endpointId, incoming.endpointId)));
      }
    }
    const incomingIds = new Set(descriptor.endpoints.map((endpoint) => endpoint.endpointId));
    const removed = device.endpoints.filter((endpoint) => !incomingIds.has(endpoint.endpointId));
    for (const endpoint of removed) {
      await this.db
        .delete(endpoints)
        .where(and(eq(endpoints.deviceId, device.id), eq(endpoints.endpointId, endpoint.endpointId)));
    }
    device.endpoints = device.endpoints.filter((endpoint) => incomingIds.has(endpoint.endpointId));
    this.events.emit('deviceUpserted', device.id);
  }
}
