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
    // The device's address on its own protocol — a Zigbee IEEE, an MQTT
    // discovery id, a Matter node. `id` is a UUID this hub minted, so it is
    // the only thing an app can use to tie a device row to something a radio
    // said: the Zigbee lifecycle stream is keyed by IEEE, and without this the
    // two never met, leaving a pairing screen to draw one physical device as
    // two rows under two names.
    externalId: device.externalId,
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
    // **Presence is the answer**, as everywhere else on this wire: absent means
    // nobody has said this one being offline is fine, which is the state of
    // nearly every device in every home. `by` is dropped when the name is —
    // `drawnBy`'s rule — since the id may point at somebody long removed and
    // the name is the only half an app draws.
    ...(device.offlineExpectedAt !== null
      ? {
          offlineExpected: {
            at: device.offlineExpectedAt,
            ...(device.offlineExpectedByName !== null
              ? { by: { id: device.offlineExpectedBy, name: device.offlineExpectedByName } }
              : {}),
          },
        }
      : {}),
    endpoints: device.endpoints.map((endpoint) => ({
      endpointId: endpoint.endpointId,
      deviceKind: endpoint.deviceKind,
      primaryCapability: endpoint.primary,
      capabilities: endpoint.capabilities,
      state: endpoint.state,
    })),
  };
}
