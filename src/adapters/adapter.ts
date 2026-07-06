import type { CapabilityKind, DeviceKind, EndpointState, HubCommand } from '../schema/index.js';

export type AdapterId = 'zigbee' | 'mqtt' | 'matter';

/** What an adapter announces when it discovers (or re-reads) a device. */
export interface AdapterDeviceDescriptor {
  adapter: AdapterId;
  /** Adapter-scoped stable id: IEEE address, MQTT device id, Matter node id. */
  externalId: string;
  vendor?: string;
  model?: string;
  /** Used as the device name on first sight; user renames win afterwards. */
  suggestedName?: string;
  endpoints: Array<{
    endpointId: number;
    deviceKind: DeviceKind;
    capabilities: CapabilityKind[];
    primary: CapabilityKind;
  }>;
  /** Set when automatic mapping was incomplete — surfaced in the apps. */
  needsReview?: boolean;
}

/**
 * The only surface adapters see of the rest of the hub. Deliberately narrow:
 * adapters never touch the database or the API — they announce devices,
 * report state, and execute commands.
 */
export interface AdapterBus {
  deviceUpserted(descriptor: AdapterDeviceDescriptor): void;
  deviceRemoved(adapter: AdapterId, externalId: string): void;
  stateChanged(
    adapter: AdapterId,
    externalId: string,
    endpointId: number,
    patch: Partial<EndpointState>,
  ): void;
  reachabilityChanged(adapter: AdapterId, externalId: string, reachable: boolean): void;
  activity(entry: { kind: string; message: string; externalId?: string; adapter?: AdapterId }): void;
}

export interface ProtocolAdapter {
  readonly id: AdapterId;
  start(bus: AdapterBus): Promise<void>;
  stop(): Promise<void>;
  execute(externalId: string, endpointId: number, command: HubCommand): Promise<void>;
  /** Forget a device at the protocol level (unpair / decommission), if supported. */
  forget?(externalId: string): Promise<void>;
}
