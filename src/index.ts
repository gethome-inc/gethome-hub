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
import { ZigbeeAdapter } from './adapters/zigbee/adapter.js';
import { MqttAdapter } from './adapters/mqtt/adapter.js';
import { MatterAdapter } from './adapters/matter/adapter.js';
import { AiDeviceMapper } from './ai/mapper.js';
import { buildServer } from './api/server.js';
import { MdnsAdvertiser } from './mdns/advertiser.js';

const version = (() => {
  try {
    const packageJson = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return (JSON.parse(readFileSync(packageJson, 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL);
  log.info(`GetHome Hub ${version} starting…`);

  const secret = ensureHubSecret(config.DATA_DIR);
  const { db, pool } = createDb(config.DATABASE_URL);
  await runMigrations(db);
  if (!(await db.query.home.findFirst())) {
    await db.insert(home).values({ name: 'My Home' });
  }

  const events = new HubEventBus();
  const activity = new ActivityService(db, events);
  const settings = new SettingsService(db, secret.aesKey);
  const pairing = new PairingService(db, config.DATA_DIR, log);
  await pairing.boot();

  const registry = new DeviceRegistry(db, events, activity, log.child({ module: 'registry' }));

  let zigbee: ZigbeeAdapter | undefined;
  let mqttAdapter: MqttAdapter | undefined;
  let matter: MatterAdapter | undefined;

  if (config.ADAPTER_ZIGBEE) {
    zigbee = new ZigbeeAdapter({
      mqttUrl: config.MQTT_URL,
      baseTopic: config.Z2M_BASE_TOPIC,
      log: log.child({ module: 'zigbee' }),
      aiAssist: new AiDeviceMapper(db, settings, log.child({ module: 'ai' })),
    });
    registry.registerAdapter(zigbee);
  }
  if (config.ADAPTER_MQTT) {
    mqttAdapter = new MqttAdapter({ mqttUrl: config.MQTT_URL, log: log.child({ module: 'mqtt' }) });
    registry.registerAdapter(mqttAdapter);
  }
  if (config.ADAPTER_MATTER) {
    matter = new MatterAdapter({ dataDir: config.DATA_DIR, log: log.child({ module: 'matter' }) });
    registry.registerAdapter(matter);
  }

  await registry.start();

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
    ...(matter ? { matter } : {}),
    ...(zigbee ? { zigbee } : {}),
  });
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  log.info(`API listening on :${config.PORT} (hub ${secret.hubId}).`);

  let mdns: MdnsAdvertiser | null = null;
  if (config.MDNS) {
    mdns = new MdnsAdvertiser({
      hubId: secret.hubId,
      hubName: config.HUB_NAME,
      port: config.PORT,
      version,
      log: log.child({ module: 'mdns' }),
    });
    try {
      await mdns.start(pairing.claimed);
    } catch (error) {
      log.warn({ err: error }, 'mDNS advertisement failed — discovery by address still works.');
    }
  }

  const shutdown = async (signal: string) => {
    log.info(`${signal} received, shutting down…`);
    await mdns?.stop().catch(() => {});
    await app.close().catch(() => {});
    await registry.stop().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('Fatal:', error);
  process.exit(1);
});
