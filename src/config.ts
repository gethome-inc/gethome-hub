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
  /**
   * What the hub signs in to its own broker as — full read/write, and the
   * account Zigbee2MQTT uses too.
   *
   * Empty means an unauthenticated broker, which is what every hub installed
   * before the broker had passwords still has: `install.sh` mints these,
   * writes them to `/etc/gethome/mqtt.env`, and the unit reads that file
   * *after* `hub.env` — so a hub that never got them simply carries on
   * connecting anonymously rather than failing to start.
   */
  MQTT_USERNAME: z.string().default(''),
  MQTT_PASSWORD: z.string().default(''),
  /**
   * The second account, and the one an owner is actually handed: it may
   * publish only under `gethome/#` and may only *read* `zigbee2mqtt/#`, so a
   * DIY board that is lost, resold or compromised cannot switch a light off,
   * open the Zigbee network, or learn anything the hub's own API would not
   * have told its owner anyway.
   *
   * The hub never connects with it. It exists to be given away, which is why
   * it is in the environment at all — `GET /settings/mqtt` is the only reader.
   */
  MQTT_INTEGRATION_USERNAME: z.string().default(''),
  MQTT_INTEGRATION_PASSWORD: z.string().default(''),
  /**
   * The address to hand an integrator, when it is not the one the hub dials.
   *
   * The hub reaches its broker over loopback and an ESP32 cannot, so the app
   * has to print something else. `install.sh` leaves this empty and the API
   * answers with the host the *request* arrived on, which is right far more
   * often than anything this process could work out for itself — a Pi with
   * Wi-Fi and Ethernet has two answers and no way to rank them. Set it when
   * the broker is somewhere else entirely.
   */
  MQTT_PUBLIC_HOST: z.string().default(''),
  Z2M_BASE_TOPIC: z.string().default('zigbee2mqtt'),
  /**
   * Zigbee2MQTT's own data directory, which the hub reads for one purpose:
   * when the radio isn't up, Z2M's log says why, and that answer belongs in
   * the API rather than in a journal on the Pi. The directory belongs to the
   * same service account the hub runs as, so this needs no privileges.
   */
  Z2M_DATA_DIR: z.string().default('/var/lib/gethome/zigbee2mqtt'),
  DATA_DIR: z.string().default('./data'),
  /**
   * The hub's name, used **only to seed it** — on the first boot of a hub that
   * has never had one. After that the name lives in the database, is what every
   * route and the mDNS advertisement report, and is changed with `PATCH /home`
   * (see `core/home.ts`). Editing this on a hub that is already running does
   * nothing, which is why it is documented as a seed everywhere it appears.
   *
   * "My Home" rather than "GetHome Hub" because this one string is now both:
   * the name of the machine on the network and the name of the home in the
   * apps, and a home called "GetHome Hub" reads like a product, not a place.
   */
  HUB_NAME: z.string().default('My Home'),
  ADAPTER_ZIGBEE: boolFlag,
  ADAPTER_MQTT: boolFlag,
  ADAPTER_MATTER: boolFlag,
  /**
   * How many radios this board can afford at once, written by `install.sh`
   * from the machine's memory. `one` means Matter and Zigbee2MQTT do not fit
   * together — a 512 MB board — and something has to choose between them.
   *
   * This is a *budget*, not a preference: which radio wins is the owner's
   * call, is stored in `<DATA_DIR>/radio-mode`, and is applied by
   * `gethome-zigbee-detect` (the only thing that knows whether a coordinator
   * is actually plugged in). The hub only reads both to say what it can talk
   * to and to record what the owner picked.
   */
  GETHOME_RADIO: z.enum(['both', 'one']).default('both'),
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

/**
 * Move any credentials out of the broker URL and into the two fields beside it.
 *
 * `mqtt://user:pass@host:1883` is the form a hand-configured hub is most
 * likely to be carrying, and it is also the form the installer used to write,
 * so it has to keep working. Normalising here rather than at the three call
 * sites buys two things: every client is constructed the same way, and the URL
 * that ends up in a log line — `MqttObserver` logs it on a failed connection —
 * no longer has a password in the middle of it.
 *
 * An explicit `MQTT_USERNAME` wins, so a URL somebody forgot to clean out
 * cannot quietly outrank the file the installer maintains.
 */
function splitBrokerCredentials(config: HubConfig): void {
  let url: URL;
  try {
    url = new URL(config.MQTT_URL);
  } catch {
    return; // Not our business to reject it — the client will say so.
  }
  if (!url.username && !url.password) return;
  if (!config.MQTT_USERNAME) {
    config.MQTT_USERNAME = decodeURIComponent(url.username);
    config.MQTT_PASSWORD = decodeURIComponent(url.password);
  }
  url.username = '';
  url.password = '';
  config.MQTT_URL = url.toString();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const config = configSchema.parse(env);
  splitBrokerCredentials(config);
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
