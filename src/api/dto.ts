import type { RegistryDevice } from '../core/registry.js';

/** Device shape served by GET /devices and the deviceUpserted WS frame. */
export function deviceWire(device: RegistryDevice) {
  return {
    id: device.id,
    // The device's address on its own protocol — a Zigbee IEEE, an MQTT
    // discovery id, a Matter node. `id` is a UUID this hub minted, so it is
    // the only thing an app can use to tie a device row to something a radio
    // said: the Zigbee lifecycle stream is keyed by IEEE, and without this the
    // two never met, leaving a pairing screen to draw one physical device as
    // two rows under two names.
    externalId: device.externalId,
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
