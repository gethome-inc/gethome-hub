import path from 'node:path';
import { z } from 'zod';

const boolFlag = z
  .string()
  .optional()
  .transform((value) => value !== '0' && value !== 'false');

const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(8420),
  /** Empty means "<DATA_DIR>/hub.db" — resolved below, once DATA_DIR is known. */
  DATABASE_FILE: z.string().default(''),
  MQTT_URL: z.string().default('mqtt://127.0.0.1:1883'),
  Z2M_BASE_TOPIC: z.string().default('zigbee2mqtt'),
  DATA_DIR: z.string().default('./data'),
  HUB_NAME: z.string().default('GetHome Hub'),
  ADAPTER_ZIGBEE: boolFlag,
  ADAPTER_MQTT: boolFlag,
  ADAPTER_MATTER: boolFlag,
  MDNS: boolFlag,
  /**
   * Who answers mDNS for this machine. `avahi` writes a static service file and
   * lets the system responder publish it; `ciao` runs our own responder in
   * process; `auto` picks avahi when it is installed.
   *
   * This exists because running both is a name conflict, not a redundancy: ciao
   * publishes an A record for `os.hostname()` — the same `<host>.local` avahi
   * already owns — and mDNS resolves a conflict by making somebody rename
   * themselves. Which one lost depended on boot order, so a Pi would answer to
   * `raspberrypi.local` right after an install and stop answering after a power
   * cut. One responder per host.
   */
  MDNS_BACKEND: z.enum(['auto', 'avahi', 'ciao', 'off']).default('auto'),
  /** Directory avahi watches for static service files. */
  AVAHI_SERVICES_DIR: z.string().default('/etc/avahi/services'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

export type HubConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const config = configSchema.parse(env);
  if (!config.DATABASE_FILE) {
    config.DATABASE_FILE = path.join(config.DATA_DIR, 'hub.db');
  }
  // A `DATABASE_URL` left over from the Postgres deployment would otherwise be
  // ignored in silence, and the hub would come up with an empty database that
  // looks like a factory reset. Name it instead.
  const legacy = env.DATABASE_URL;
  if (legacy && !legacy.startsWith('file:')) {
    throw new Error(
      `DATABASE_URL is set to "${legacy}", but the hub now stores everything in a local SQLite file. ` +
        'Remove DATABASE_URL, or set DATABASE_FILE to the path you want.',
    );
  }
  if (legacy?.startsWith('file:')) {
    config.DATABASE_FILE = legacy.slice('file:'.length);
  }
  return config;
}
