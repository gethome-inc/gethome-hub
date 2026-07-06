import { z } from 'zod';

const boolFlag = z
  .string()
  .optional()
  .transform((value) => value !== '0' && value !== 'false');

const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(8420),
  DATABASE_URL: z
    .string()
    .default('postgres://gethome:gethome@127.0.0.1:5432/gethome'),
  MQTT_URL: z.string().default('mqtt://127.0.0.1:1883'),
  Z2M_BASE_TOPIC: z.string().default('zigbee2mqtt'),
  DATA_DIR: z.string().default('./data'),
  HUB_NAME: z.string().default('GetHome Hub'),
  ADAPTER_ZIGBEE: boolFlag,
  ADAPTER_MQTT: boolFlag,
  ADAPTER_MATTER: boolFlag,
  MDNS: boolFlag,
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

export type HubConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  return configSchema.parse(env);
}
