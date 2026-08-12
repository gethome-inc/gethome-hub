import type { CapabilityKind, DeviceKind, EndpointState, HubCommand } from '../schema/index.js';

export type AdapterId = 'zigbee' | 'mqtt' | 'matter';

/**
 * How a device came to be understood.
 *
 * `needsReview` is the verdict and was for a long time the only thing recorded,
 * so an app could say "something about this device is missing" and never which
 * of the three layers had placed it or which properties were left over. That
 * made the layering — typed capabilities, then generic custom fields, then AI —
 * invisible to the person paying for the third one.
 *
 * `source` names the **highest layer that was needed**, so a device reading
 * `static` was fully understood with no key and no cost, and one reading `ai`
 * is the reason there is a bill.
 */
export interface DeviceRecognition {
  source: 'static' | 'custom-fields' | 'ai' | 'imported' | 'none';
  /** Properties with no representation at all — what `needsReview` is about. */
  uncovered: string[];
  /** Properties reachable only as generic controls, not typed capabilities. */
  unmapped: string[];
  /** Identifies the device *model*, and so its entry in the mapping library. */
  exposesHash?: string;
}

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
  /** How it was placed, and what was left over. */
  recognition?: DeviceRecognition;
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
