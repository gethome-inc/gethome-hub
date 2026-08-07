import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig } from './config.js';
import { createLogger } from './logging.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { home } from './db/schema.js';
import { ensureHubSecret } from './core/crypto.js';
import { HubEventBus } from './core/bus.js';
import { ActivityService } from './core/activity.js';
import { PairingService } from './core/pairing.js';
import { SettingsService } from './core/settings.js';
import { DeviceRegistry } from './core/registry.js';
import { buildServer } from './api/server.js';
import { MdnsAdvertiser } from './mdns/advertiser.js';
import { lazyAiAssist } from './ai/lazy.js';
import type { ZigbeeAdapter } from './adapters/zigbee/adapter.js';
import type { MqttAdapter } from './adapters/mqtt/adapter.js';
import type { MatterAdapter } from './adapters/matter/adapter.js';

const installRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const version = (() => {
  try {
    const packageJson = path.join(installRoot, 'package.json');
    return (JSON.parse(readFileSync(packageJson, 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();

/**
 * Which build this is, stamped by CI into the bundle.
 *
 * `version` alone is the package version, which barely moves and is the same
 * on every build of a branch — so "0.1.0" was the only answer the app could
 * give to "what is running on my Pi", including after an update. This is
 * `<version>-<short sha>-<branch>`, it names the release directory the
 * installer unpacked into, and it is absent only for a hub built from source
 * on the machine itself.
 */
const build = (() => {
  try {
    const stamped = readFileSync(path.join(installRoot, 'VERSION'), 'utf8').trim();
    return stamped.length > 0 ? stamped : undefined;
  } catch {
    return undefined;
  }
})();

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL);
  log.info(`GetHome Hub ${version} starting…${build ? ` (build ${build})` : ''}`);

  const secret = ensureHubSecret(config.DATA_DIR);
  const { db, close } = createDb(config.DATABASE_FILE);
  runMigrations(db);
  if (!(await db.query.home.findFirst())) {
    await db.insert(home).values({ name: 'My Home' });
  }

  const events = new HubEventBus();
  const activity = new ActivityService(db, events);
  const settings = new SettingsService(db, secret.aesKey);
  const pairing = new PairingService(db, config.DATA_DIR, log);
  await pairing.boot();

  const registry = new DeviceRegistry(db, events, activity, log.child({ module: 'registry' }));

  // Adapters are *constructed* here and *started* after the API is listening.
  // The modules are imported dynamically for one reason that matters on a small
  // board: matter.js is by far the largest thing in the dependency graph, and a
  // static import loads it into memory whether or not the adapter is enabled —
  // so `ADAPTER_MATTER=0` used to save the work but not the megabytes.
  let zigbee: ZigbeeAdapter | undefined;
  let mqttAdapter: MqttAdapter | undefined;
  let matter: MatterAdapter | undefined;

  if (config.ADAPTER_ZIGBEE) {
    const { ZigbeeAdapter } = await import('./adapters/zigbee/adapter.js');
    zigbee = new ZigbeeAdapter({
      mqttUrl: config.MQTT_URL,
      baseTopic: config.Z2M_BASE_TOPIC,
      log: log.child({ module: 'zigbee' }),
      aiAssist: lazyAiAssist({ db, settings, log: log.child({ module: 'ai' }) }),
    });
    registry.registerAdapter(zigbee);
  }
  if (config.ADAPTER_MQTT) {
    const { MqttAdapter } = await import('./adapters/mqtt/adapter.js');
    mqttAdapter = new MqttAdapter({ mqttUrl: config.MQTT_URL, log: log.child({ module: 'mqtt' }) });
    registry.registerAdapter(mqttAdapter);
  }
  if (config.ADAPTER_MATTER) {
    const { MatterAdapter } = await import('./adapters/matter/adapter.js');
    matter = new MatterAdapter({ dataDir: config.DATA_DIR, log: log.child({ module: 'matter' }) });
    registry.registerAdapter(matter);
  }

  const app = await buildServer({
    db,
    log,
    events,
    registry,
    pairing,
    activity,
    settings,
    hubId: secret.hubId,
    hubName: config.HUB_NAME,
    version,
    ...(build ? { build } : {}),
    ...(matter ? { matter } : {}),
    ...(zigbee ? { zigbee } : {}),
  });

  // Listen *before* the adapters start. Starting them first meant a broker that
  // wasn't up yet, or matter.js opening its storage on a slow SD card, held the
  // API closed — and with it the installer's health check and the claim. The
  // hub has always been designed to run with no devices and no radios; this
  // makes the boot match that.
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  log.info(`API listening on :${config.PORT} (hub ${secret.hubId}).`);

  let mdns: MdnsAdvertiser | null = null;
  if (config.MDNS) {
    mdns = new MdnsAdvertiser({
      hubId: secret.hubId,
      hubName: config.HUB_NAME,
      port: config.PORT,
      version,
      backend: config.MDNS_BACKEND,
      servicesDir: config.AVAHI_SERVICES_DIR,
      log: log.child({ module: 'mdns' }),
    });
    try {
      await mdns.start(pairing.claimed);
    } catch (error) {
      log.warn({ err: error }, 'mDNS advertisement failed — discovery by address still works.');
    }
    // The TXT record used to say `claimed=0` until the next restart, which is
    // how a claimed hub kept advertising itself as available to claim.
    pairing.onClaimed = () => mdns?.updateClaimed(true);
  }

  void registry.start().catch((error) => {
    log.error({ err: error }, 'Device registry failed to start.');
  });

  const stopping = { value: false };
  const shutdown = async (signal: string) => {
    if (stopping.value) return;
    stopping.value = true;
    log.info(`${signal} received, shutting down…`);
    await mdns?.stop().catch(() => {});
    await app.close().catch(() => {});
    await registry.stop().catch(() => {});
    try {
      close();
    } catch {
      // Already closed, or never opened.
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('Fatal:', error);
  process.exit(1);
});
