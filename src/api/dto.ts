import type { RegistryDevice } from '../core/registry.js';

/**
 * Device shape served by GET /devices and the deviceUpserted WS frame.
 *
 * `favorite` is the **caller's** pin, not the device's — see
 * `core/favorites.ts`. The field name and shape are unchanged, deliberately:
 * an app written against the old shared flag reads its own favorites here
 * without knowing anything happened. It has to be passed in rather than read
 * off the device, because one device answers differently to each member, and
 * the WebSocket renders this per socket for exactly that reason.
 */
export function deviceWire(device: RegistryDevice, favorite: boolean) {
  return {
    id: device.id,
    name: device.name,
    roomId: device.roomId,
    favorite,
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
