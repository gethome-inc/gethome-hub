import type { RegistryDevice } from '../core/registry.js';

/** Device shape served by GET /devices and the deviceUpserted WS frame. */
export function deviceWire(device: RegistryDevice) {
  return {
    id: device.id,
    name: device.name,
    roomId: device.roomId,
    favorite: device.favorite,
    online: device.online,
    adapter: device.adapter,
    vendor: device.vendor,
    model: device.model,
    needsReview: device.needsReview,
    // Additive, and absent on a device adopted before the hub recorded it —
    // which an app must read as "not known", never as "recognised by nothing".
    ...(device.recognition ? { recognition: device.recognition } : {}),
    endpoints: device.endpoints.map((endpoint) => ({
      endpointId: endpoint.endpointId,
      deviceKind: endpoint.deviceKind,
      primaryCapability: endpoint.primary,
      capabilities: endpoint.capabilities,
      state: endpoint.state,
    })),
  };
}
