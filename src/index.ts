import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig } from './config.js';
import { createLogger } from './logging.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { ensureHubSecret } from './core/crypto.js';
import { HubEventBus } from './core/bus.js';
import { ActivityService } from './core/activity.js';
import { HomeService } from './core/home.js';
import { PairingService } from './core/pairing.js';
import { SettingsService } from './core/settings.js';
import { DeviceRegistry } from './core/registry.js';
import { MqttObserver } from './core/mqtt-observer.js';
import { PermitJoinService } from './core/permit-join.js';
import { activityForLifecycleEvent, normalizeBridgeEvent } from './core/zigbee-events.js';
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

  // The hub's name and the home's name are one string, stored once. `HUB_NAME`
  // only seeds it, on the first boot of a hub that has never had one — after
  // that the database owns it and `PATCH /home` is what changes it.
  const homeService = new HomeService(db, config.HUB_NAME);
  await homeService.boot();

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

  // The Zigbee join window, and its countdown. Constructed before the adapter
  // so the adapter's `bridge/info` relay has something to report to; the radio
  // is handed over below, once it exists.
  const permitJoin = new PermitJoinService(undefined, log.child({ module: 'zigbee' }), (state) => {
    events.emit('permitJoin', state.active, state.remainingSeconds);
  });

  if (config.ADAPTER_ZIGBEE) {
    const { ZigbeeAdapter } = await import('./adapters/zigbee/adapter.js');
    zigbee = new ZigbeeAdapter({
      mqttUrl: config.MQTT_URL,
      baseTopic: config.Z2M_BASE_TOPIC,
      log: log.child({ module: 'zigbee' }),
      aiAssist: lazyAiAssist({ db, settings, log: log.child({ module: 'ai' }) }),
      onBridgeInfo: (info) => permitJoin.observeBridgeInfo(info),
      onBridgeEvent: (raw) => {
        const event = normalizeBridgeEvent(raw);
        if (!event) return;
        events.emit('zigbeeEvent', event);
        const entry = activityForLifecycleEvent(event);
        if (entry) void activity.record(entry).catch(() => undefined);
      },
    });
    permitJoin.useRadio(zigbee);
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

  // The broker tap behind the apps' traffic inspector. Constructed whenever a
  // broker is part of this hub's design, and *connected* only while somebody
  // is watching — a hub with no inspector open pays for none of it. Its
  // output goes to the UI and nowhere else: it is not an input to device
  // adoption, and never to the AI mapper.
  const mqttObserver =
    config.ADAPTER_ZIGBEE || config.ADAPTER_MQTT
      ? new MqttObserver({
          mqttUrl: config.MQTT_URL,
          z2mBaseTopic: config.Z2M_BASE_TOPIC,
          log: log.child({ module: 'mqtt-observer' }),
          onFrame: (frame) => events.emit('mqttFrame', frame),
        })
      : undefined;

  const app = await buildServer({
    db,
    log,
    events,
    registry,
    pairing,
    activity,
    settings,
    home: homeService,
    hubId: secret.hubId,
    version,
    dataDir: config.DATA_DIR,
    radioBudget: config.GETHOME_RADIO,
    z2mDataDir: config.Z2M_DATA_DIR,
    permitJoin,
    ...(build ? { build } : {}),
    ...(matter ? { matter } : {}),
    ...(zigbee ? { zigbee } : {}),
    ...(mqttObserver ? { mqttObserver } : {}),
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
      hubName: homeService.name,
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

  // A rename has to reach the network too, or the hub answers to its new name
  // over HTTP and advertises its old one until the next restart. Set after the
  // advertiser exists; a rename in the milliseconds before this is covered by
  // `start()` publishing whatever the name is by then.
  homeService.onRenamed = (name) => {
    log.info({ name }, 'Hub renamed.');
    void mdns?.updateName(name);
  };

  void registry.start().catch((error) => {
    log.error({ err: error }, 'Device registry failed to start.');
  });

  const stopping = { value: false };
  const shutdown = async (signal: string) => {
    if (stopping.value) return;
    stopping.value = true;
    log.info(`${signal} received, shutting down…`);
    permitJoin.stop();
    await mdns?.stop().catch(() => {});
    await app.close().catch(() => {});
    await mqttObserver?.stop().catch(() => {});
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
