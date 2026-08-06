import { randomUUID } from 'node:crypto';
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

/** Commands the registry resolves against stored IR state (not the adapter). */
function isIrLibraryCommand(
  command: HubCommand,
): command is Extract<HubCommand, { type: 'irLearn' | 'irSaveLearned' | 'irSend' | 'irDeleteCommand' | 'irRenameCommand' }> {
  return (
    command.type === 'irLearn' ||
    command.type === 'irSaveLearned' ||
    command.type === 'irSend' ||
    command.type === 'irDeleteCommand' ||
    command.type === 'irRenameCommand'
  );
}

/** How long endpoint-state writes coalesce before they reach the database. */
const STATE_FLUSH_MS = 2_000;

/** A blank endpoint state, plus the IR library base when the endpoint has one. */
function freshEndpointState(capabilities: CapabilityKind[]): EndpointState {
  const state = emptyState();
  if (capabilities.includes('irRemote')) state.irRemote = { learning: false, commands: [] };
  return state;
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
  /** Same objects as `cache`, keyed by device id — `getDevice` is on every command. */
  private readonly byId = new Map<string, RegistryDevice>();
  private readonly queue = new Map<string, Promise<void>>();

  /**
   * Endpoint states whose row is behind the cache, keyed `deviceId:endpointId`.
   *
   * Persisting on every report meant one whole-row JSON rewrite per sensor
   * message, forever, onto an SD card — a power meter alone is a write every
   * few seconds. The cache is already authoritative while the hub runs; the row
   * only has to be right when it restarts. So writes coalesce into one flush a
   * couple of seconds later, and `stop()` flushes before the process leaves.
   */
  private readonly dirtyState = new Map<string, { deviceId: string; endpointId: number }>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

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
    // Two queries, not one per device. The old shape issued an `endpoints`
    // query inside the device loop, so boot time grew with the size of the
    // home on exactly the machines least able to afford it.
    const rows = await this.db.query.devices.findMany();
    const endpointRows = await this.db.query.endpoints.findMany();
    const byDevice = new Map<string, typeof endpointRows>();
    for (const endpoint of endpointRows) {
      const list = byDevice.get(endpoint.deviceId);
      if (list) list.push(endpoint);
      else byDevice.set(endpoint.deviceId, [endpoint]);
    }
    for (const row of rows) {
      const device: RegistryDevice = {
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
        endpoints: (byDevice.get(row.id) ?? []).map((endpoint) => ({
          endpointId: endpoint.endpointId,
          deviceKind: endpoint.deviceKind as DeviceKind,
          capabilities: endpoint.capabilities as CapabilityKind[],
          primary: endpoint.primaryCapability as CapabilityKind,
          state: endpoint.state as EndpointState,
        })),
      };
      this.cache.set(this.key(device.adapter, device.externalId), device);
      this.byId.set(device.id, device);
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
    await this.flush();
  }

  /** Write every endpoint state the cache is holding ahead of its row. */
  private async flushState(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.dirtyState.size === 0) return;
    const pending = [...this.dirtyState.values()];
    this.dirtyState.clear();
    const now = new Date();
    for (const { deviceId, endpointId } of pending) {
      const device = this.byId.get(deviceId);
      const endpoint = device?.endpoints.find((candidate) => candidate.endpointId === endpointId);
      if (!endpoint) continue;
      try {
        await this.db
          .update(endpoints)
          .set({ state: endpoint.state, updatedAt: now })
          .where(and(eq(endpoints.deviceId, deviceId), eq(endpoints.endpointId, endpointId)));
      } catch (error) {
        this.log.error({ err: error }, 'Persisting endpoint state failed');
      }
    }
  }

  private markStateDirty(deviceId: string, endpointId: number): void {
    this.dirtyState.set(`${deviceId}:${endpointId}`, { deviceId, endpointId });
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushState();
    }, STATE_FLUSH_MS);
    // A pending flush must never be the reason a process stays alive.
    this.flushTimer.unref?.();
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
      this.byId.delete(cached.id);
      // Drop queued state writes for a device that no longer exists, so a
      // flush can't try to update rows the cascade has already taken away.
      for (const [key, entry] of this.dirtyState) {
        if (entry.deviceId === cached.id) this.dirtyState.delete(key);
      }
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
      this.markStateDirty(cached.id, endpointId);
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
    return this.byId.get(deviceId);
  }

  async execute(deviceId: string, endpointId: number, command: HubCommand): Promise<void> {
    const device = this.getDevice(deviceId);
    if (!device) throw new Error(`Unknown device ${deviceId}`);
    // IR-library commands resolve against stored endpoint state, which the
    // registry owns; only learn + the resolved raw send reach the adapter.
    if (isIrLibraryCommand(command)) {
      await this.executeIr(device, endpointId, command);
      return;
    }
    const adapter = this.adapters.get(device.adapter);
    if (!adapter) throw new Error(`Adapter "${device.adapter}" is not running`);
    await adapter.execute(device.externalId, endpointId, command);
  }

  /**
   * IR blaster / universal remote command handling. The learned-code library
   * lives in `endpoint.state.irRemote` (persisted jsonb, hub-authoritative):
   * save/delete/rename mutate it here; send resolves the opaque blob and hands
   * it to the adapter as `irSendRaw`; learn is forwarded and optimistically
   * reflected. Every mutation runs on the per-device write queue.
   */
  private async executeIr(
    device: RegistryDevice,
    endpointId: number,
    command: Extract<HubCommand, { type: `ir${string}` }>,
  ): Promise<void> {
    const endpoint = device.endpoints.find((candidate) => candidate.endpointId === endpointId);
    if (!endpoint || !endpoint.capabilities.includes('irRemote')) {
      throw new Error('device has no IR remote on this endpoint');
    }
    const adapter = this.adapters.get(device.adapter);
    const key = this.key(device.adapter, device.externalId);

    switch (command.type) {
      case 'irLearn': {
        if (adapter) await adapter.execute(device.externalId, endpointId, command);
        this.mutateIr(device, endpointId, (ir) => {
          ir.learning = command.on;
          if (command.on) delete ir.pendingCode; // a fresh learn discards the unsaved one
        });
        await this.flush(key);
        return;
      }
      case 'irSend': {
        const library = endpoint.state.irRemote?.commands ?? [];
        const found = library.find((entry) => entry.id === command.commandId);
        if (!found) throw new Error('unknown IR command');
        if (adapter) {
          await adapter.execute(device.externalId, endpointId, { type: 'irSendRaw', code: found.code });
        }
        return;
      }
      case 'irSaveLearned': {
        const code = endpoint.state.irRemote?.pendingCode;
        if (!code) throw new Error('no learned IR code to save');
        this.mutateIr(device, endpointId, (ir) => {
          ir.commands = [...ir.commands, { id: randomUUID(), name: command.name, code }];
          ir.learning = false;
          delete ir.pendingCode;
        });
        await this.flush(key);
        return;
      }
      case 'irDeleteCommand': {
        this.mutateIr(device, endpointId, (ir) => {
          ir.commands = ir.commands.filter((entry) => entry.id !== command.commandId);
        });
        await this.flush(key);
        return;
      }
      case 'irRenameCommand': {
        this.mutateIr(device, endpointId, (ir) => {
          ir.commands = ir.commands.map((entry) =>
            entry.id === command.commandId ? { ...entry, name: command.name } : entry,
          );
        });
        await this.flush(key);
        return;
      }
    }
  }

  /** Serialized read-modify-write of one endpoint's IR library. */
  private mutateIr(
    device: RegistryDevice,
    endpointId: number,
    mutate: (ir: NonNullable<EndpointState['irRemote']>) => void,
  ): void {
    const key = this.key(device.adapter, device.externalId);
    this.enqueue(key, async () => {
      const cached = this.cache.get(key);
      const endpoint = cached?.endpoints.find((candidate) => candidate.endpointId === endpointId);
      if (!cached || !endpoint) return;
      const current = endpoint.state.irRemote;
      const next: NonNullable<EndpointState['irRemote']> = {
        learning: current?.learning ?? false,
        commands: current?.commands ? [...current.commands] : [],
        ...(current?.pendingCode !== undefined ? { pendingCode: current.pendingCode } : {}),
      };
      mutate(next);
      endpoint.state = { ...endpoint.state, irRemote: next };
      await this.db
        .update(endpoints)
        .set({ state: endpoint.state, updatedAt: new Date() })
        .where(and(eq(endpoints.deviceId, cached.id), eq(endpoints.endpointId, endpointId)));
      this.events.emit('stateChanged', cached.id, endpointId, endpoint.state);
    });
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

  /**
   * Await all pending writes — used by tests and shutdown. Draining the
   * per-device queues is only half of it: endpoint state is deliberately
   * written behind a debounce, so "everything is on disk" also means flushing
   * that.
   */
  async flush(key?: string): Promise<void> {
    if (key) {
      await this.queue.get(key);
    } else {
      await Promise.all([...this.queue.values()]);
    }
    await this.flushState();
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
      const state = freshEndpointState(endpoint.capabilities);
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
    this.byId.set(device.id, device);
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
        const state = freshEndpointState(incoming.capabilities);
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
      this.dirtyState.delete(`${device.id}:${endpoint.endpointId}`);
      await this.db
        .delete(endpoints)
        .where(and(eq(endpoints.deviceId, device.id), eq(endpoints.endpointId, endpoint.endpointId)));
    }
    device.endpoints = device.endpoints.filter((endpoint) => incomingIds.has(endpoint.endpointId));
    this.events.emit('deviceUpserted', device.id);
  }
}
