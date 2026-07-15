import mqtt from 'mqtt';
import type { AdapterBus, ProtocolAdapter } from '../adapter.js';
import {
  mqttDiscoverySchema,
  statePatchSchema,
  type HubCommand,
  type MqttDiscoveryConfig,
} from '../../schema/index.js';
import { commandTopic, parseTopic, subscriptionPatterns } from './convention.js';
import type { Logger } from '../../logging.js';

export interface MqttAdapterOptions {
  mqttUrl: string;
  log: Logger;
}

/**
 * Generic MQTT integrations following the GetHome convention
 * (src/adapters/mqtt/convention.ts). Because both directions use the
 * canonical schema, this adapter is also the reference implementation —
 * and the fake device driver used by the integration tests.
 */
export class MqttAdapter implements ProtocolAdapter {
  readonly id = 'mqtt' as const;

  private client: mqtt.MqttClient | null = null;
  private bus: AdapterBus | null = null;
  private readonly known = new Map<string, MqttDiscoveryConfig>();

  constructor(private readonly options: MqttAdapterOptions) {}

  async start(bus: AdapterBus): Promise<void> {
    this.bus = bus;
    const client = await mqtt.connectAsync(this.options.mqttUrl, {
      clientId: `gethome-hub-mqtt-${Math.random().toString(16).slice(2, 8)}`,
      reconnectPeriod: 2000,
    });
    this.client = client;
    client.on('message', (topic, payload) => {
      try {
        this.handleMessage(topic, payload.toString('utf8'));
      } catch (error) {
        this.options.log.warn({ err: error, topic }, 'Failed to handle MQTT integration message');
      }
    });
    await client.subscribeAsync(subscriptionPatterns());
    this.options.log.info('MQTT integration adapter listening on gethome/#');
  }

  async stop(): Promise<void> {
    await this.client?.endAsync();
    this.client = null;
  }

  async execute(externalId: string, endpointId: number, command: HubCommand): Promise<void> {
    if (!this.client) throw new Error('MQTT adapter is not connected');
    if (!this.known.has(externalId)) throw new Error(`Unknown MQTT device ${externalId}`);
    await this.client.publishAsync(commandTopic(externalId, endpointId), JSON.stringify(command));
  }

  private handleMessage(topic: string, payload: string): void {
    const parsed = parseTopic(topic);
    if (!parsed) return;

    switch (parsed.kind) {
      case 'discovery': {
        if (payload.trim() === '') {
          // Empty retained config = the integration removed the device.
          if (this.known.delete(parsed.deviceId)) {
            this.bus?.deviceRemoved('mqtt', parsed.deviceId);
          }
          return;
        }
        const result = mqttDiscoverySchema.safeParse(JSON.parse(payload));
        if (!result.success) {
          this.options.log.warn(
            { deviceId: parsed.deviceId, issues: result.error.issues },
            'Rejected invalid MQTT discovery config',
          );
          this.bus?.activity({
            kind: 'mqtt.invalid',
            message: `Rejected invalid MQTT discovery config for "${parsed.deviceId}".`,
          });
          return;
        }
        const config = result.data;
        this.known.set(parsed.deviceId, config);
        this.bus?.deviceUpserted({
          adapter: 'mqtt',
          externalId: parsed.deviceId,
          ...(config.vendor ? { vendor: config.vendor } : {}),
          ...(config.model ? { model: config.model } : {}),
          suggestedName: config.name,
          endpoints: config.endpoints.map((endpoint) => ({
            endpointId: endpoint.endpointId,
            deviceKind: endpoint.deviceKind,
            capabilities: endpoint.capabilities,
            primary: endpoint.primary,
          })),
        });
        return;
      }

      case 'state': {
        if (!this.known.has(parsed.deviceId)) return;
        const result = statePatchSchema.safeParse(JSON.parse(payload));
        if (!result.success) {
          this.options.log.warn({ deviceId: parsed.deviceId }, 'Rejected invalid MQTT state payload');
          return;
        }
        // An event without a timestamp gets one on arrival, like the Zigbee
        // and AI paths — integrators shouldn't need a clock to report a press.
        const patch = result.data;
        if (patch.event && (patch.event.action ?? patch.event.gesture ?? patch.event.button) !== undefined) {
          patch.event.at ??= Date.now();
        }
        this.bus?.stateChanged(
          'mqtt',
          parsed.deviceId,
          parsed.endpointId,
          // zod's deep-partial output is structurally a state patch; the cast
          // bridges exactOptionalPropertyTypes.
          patch as Partial<import('../../schema/index.js').EndpointState>,
        );
        return;
      }

      case 'availability': {
        if (!this.known.has(parsed.deviceId)) return;
        this.bus?.reachabilityChanged('mqtt', parsed.deviceId, payload.trim() === 'online');
        return;
      }
    }
  }
}
