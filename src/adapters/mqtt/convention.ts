/**
 * The GetHome MQTT integration convention — the public contract for wiring
 * custom devices (DIY hardware, wired controllers, bridges) into a GetHome
 * hub. Both directions speak the canonical schema, so integrations need no
 * per-device mapping layer. Documented in docs/mqtt-integrations.md.
 *
 * Topics (deviceId: [A-Za-z0-9_-], 1–64 chars):
 *
 *   gethome/discovery/<deviceId>/config        retained JSON — declares the device
 *   gethome/device/<deviceId>/state            retained JSON — canonical state patch (endpoint 1)
 *   gethome/device/<deviceId>/state/<epId>     retained JSON — per-endpoint state patch
 *   gethome/device/<deviceId>/availability     retained "online"/"offline" (use as MQTT LWT)
 *   gethome/device/<deviceId>/set              hub → device: canonical command JSON (endpoint 1)
 *   gethome/device/<deviceId>/set/<epId>       hub → device: per-endpoint command
 *
 * Publishing an empty retained payload to the config topic removes the device.
 */

export const MQTT_NAMESPACE = 'gethome';

export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type ParsedMqttTopic =
  | { kind: 'discovery'; deviceId: string }
  | { kind: 'state'; deviceId: string; endpointId: number }
  | { kind: 'availability'; deviceId: string }
  | null;

export function parseTopic(topic: string): ParsedMqttTopic {
  const parts = topic.split('/');
  if (parts[0] !== MQTT_NAMESPACE) return null;

  if (parts[1] === 'discovery' && parts.length === 4 && parts[3] === 'config') {
    const deviceId = parts[2]!;
    return DEVICE_ID_PATTERN.test(deviceId) ? { kind: 'discovery', deviceId } : null;
  }

  if (parts[1] === 'device' && parts.length >= 3) {
    const deviceId = parts[2]!;
    if (!DEVICE_ID_PATTERN.test(deviceId)) return null;
    if (parts[3] === 'state' && (parts.length === 4 || parts.length === 5)) {
      const endpointId = parts.length === 5 ? Number(parts[4]) : 1;
      if (!Number.isInteger(endpointId) || endpointId < 0) return null;
      return { kind: 'state', deviceId, endpointId };
    }
    if (parts[3] === 'availability' && parts.length === 4) {
      return { kind: 'availability', deviceId };
    }
  }
  return null;
}

export function commandTopic(deviceId: string, endpointId: number): string {
  return endpointId === 1
    ? `${MQTT_NAMESPACE}/device/${deviceId}/set`
    : `${MQTT_NAMESPACE}/device/${deviceId}/set/${endpointId}`;
}

export function subscriptionPatterns(): string[] {
  return [`${MQTT_NAMESPACE}/discovery/+/config`, `${MQTT_NAMESPACE}/device/+/state`, `${MQTT_NAMESPACE}/device/+/state/+`, `${MQTT_NAMESPACE}/device/+/availability`];
}
