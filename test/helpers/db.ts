import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { HomeService } from '../../src/core/home.js';
import { FavoritesService } from '../../src/core/favorites.js';
import { AccessService } from '../../src/core/access.js';
import { HistoryService } from '../../src/core/history.js';
import { PortraitService } from '../../src/portraits/store.js';
import { ActivityService } from '../../src/core/activity.js';
import { AutomationEngine, type EngineRegistry } from '../../src/automations/engine.js';
import { AutomationStore } from '../../src/automations/store.js';
import { AutomationChat, type AutomationChatOptions } from '../../src/ai/automation-chat.js';
import { AiRunLog } from '../../src/core/ai-runs.js';
import { SettingsService } from '../../src/core/settings.js';
import type { HubEventBus } from '../../src/core/bus.js';
import type { MqttBrokerConfig } from '../../src/core/mqtt-access.js';
import {
  activity,
  aiMappings,
  aiRuns,
  automationRuns,
  automationVersions,
  automations,
  deviceFavorites,
  devicePortraits,
  devices,
  endpoints,
  history,
  historySeries,
  home,
  invites,
  members,
  roles,
  rooms,
  settings,
  tokens,
  zones,
} from '../../src/db/schema.js';

export interface TestDb {
  db: Db;
  close: () => Promise<void>;
}

/**
 * Open a throwaway SQLite database and migrate it.
 *
 * This used to connect to a Postgres that might not be running, so every suite
 * that touched the database had to be able to skip itself. Nothing to skip
 * now — the store is a file — so the return type stays nullable only because
 * callers still guard on it, and it is never null in practice.
 */
export async function openTestDb(): Promise<TestDb | null> {
  const dir = mkdtempSync(path.join(tmpdir(), 'gethome-test-'));
  const { db, close } = createDb(path.join(dir, 'hub.db'));
  runMigrations(db);
  return {
    db,
    close: async () => {
      close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Wipe all data between tests, keeping the schema. Children first: foreign keys
 * are enforced here (they were not, by default, in SQLite) so the order is not
 * cosmetic.
 */
export async function resetDb(db: Db): Promise<void> {
  await db.delete(activity);
  await db.delete(automationRuns);
  await db.delete(automationVersions);
  await db.delete(automations);
  await db.delete(tokens);
  await db.delete(invites);
  await db.delete(endpoints);
  await db.delete(history);
  await db.delete(historySeries);
  await db.delete(deviceFavorites);
  await db.delete(devicePortraits);
  await db.delete(devices);
  await db.delete(members);
  // Built-in roles are seeded by the migration and are part of the schema a
  // hub boots with, so they stay. A role a test invented does not.
  await db.delete(roles).where(eq(roles.builtin, false));
  await db.delete(rooms);
  await db.delete(zones);
  await db.delete(home);
  await db.delete(aiMappings);
  await db.delete(aiRuns);
  await db.delete(settings);
}

/**
 * A `HomeService` with its row created, which is what `src/index.ts` hands the
 * API on a real hub. `resetDb` deletes the `home` row, so a suite that resets
 * and then builds a server has to seed it again the same way the hub does.
 */
export async function bootedHome(db: Db, name: string): Promise<HomeService> {
  const service = new HomeService(db, name);
  await service.boot();
  return service;
}

/**
 * A `FavoritesService` with its rows read in, which is what `src/index.ts`
 * hands the API. Every suite that builds a server needs one: `GET /devices`
 * asks it who pinned what, so a server built without it answers 500.
 */
export async function loadedFavorites(db: Db, events: HubEventBus): Promise<FavoritesService> {
  const favorites = new FavoritesService(db, events);
  await favorites.load();
  return favorites;
}

/**
 * An `AccessService` with the roles read in, which is what `src/index.ts` hands
 * the API and the pairing service. Every suite that builds a server needs one:
 * it answers "may this member?" on every authenticated route, and the pairing
 * service asks it for the role a claim should land in.
 */
export async function loadedAccess(db: Db, events: HubEventBus): Promise<AccessService> {
  const access = new AccessService(db, events);
  await access.load();
  return access;
}

/**
 * A started `HistoryService`, which is what `src/index.ts` hands the API.
 *
 * Every suite that builds a server needs one — `GET /hub` asks it what it
 * records, so a server built without it answers 500 on the health check every
 * other test leans on.
 */
export async function startedHistory(db: Db, events: HubEventBus): Promise<HistoryService> {
  const service = new HistoryService(db, events, pino({ level: 'silent' }));
  await service.start();
  return service;
}

/**
 * A portrait service writing into a temp directory. Nothing here draws — that
 * needs an OpenAI key — so a suite gets the routes, the rows and the bounds
 * without a network.
 */
export function testPortraits(db: Db, events: HubEventBus, dataDir?: string): PortraitService {
  return new PortraitService(
    db,
    events,
    dataDir ?? mkdtempSync(path.join(tmpdir(), 'gethome-portraits-')),
    pino({ level: 'silent' }),
  );
}

/**
 * The broker facts `buildServer` needs, as a hub with a password-protected
 * broker really carries them.
 *
 * A named fixture rather than a literal at four call sites: `ApiDeps.mqtt` is
 * required precisely so a suite cannot forget it, and four hand-copied
 * literals is the shape that goes stale one at a time. Pass overrides to test
 * a hub whose installer never set a password up.
 */
export function testBroker(
  overrides: Partial<MqttBrokerConfig> = {},
): MqttBrokerConfig {
  return {
    url: 'mqtt://127.0.0.1:1883',
    username: 'gethome-hub',
    password: 'hub-secret',
    integrationUsername: 'gethome',
    integrationPassword: 'integration-secret',
    publicHost: '',
    baseTopic: 'zigbee2mqtt',
    ...overrides,
  };
}

/**
 * A started `AutomationEngine` and its store, which is what `src/index.ts`
 * hands the API.
 *
 * A named fixture rather than a literal per suite, for the reason `testBroker`
 * is one: `ApiDeps` requires both fields precisely so a suite cannot forget
 * them, and five hand-built engines is the shape that goes stale one at a
 * time. The clock is injectable for the suites that care about schedules; the
 * rest take the real one and never reach the scheduler.
 */
export async function startedAutomations(
  db: Db,
  events: HubEventBus,
  registry: EngineRegistry,
  activity: ActivityService,
  options: {
    now?: () => number;
    timezone?: () => string;
    /** The suite's own, when it has one — otherwise a throwaway with no key,
     *  which is what a hub that has never been given one looks like. */
    settings?: SettingsService;
    runs?: AiRunLog;
    /** Stands in for a provider, so a suite never reaches one. */
    createConversation?: AutomationChatOptions['createConversation'];
  } = {},
): Promise<{ engine: AutomationEngine; store: AutomationStore; chat: AutomationChat }> {
  const store = new AutomationStore(db);
  const engine = new AutomationEngine({
    store,
    registry,
    events,
    activity,
    log: pino({ level: 'silent' }),
    readStructure: async () => {
      const [roomRows, zoneRows] = await Promise.all([
        db.query.rooms.findMany(),
        db.query.zones.findMany(),
      ]);
      return {
        rooms: roomRows.map((row) => ({ id: row.id, name: row.name, zoneId: row.zoneId })),
        zones: zoneRows.map((row) => ({ id: row.id, name: row.name })),
      };
    },
    timezone: options.timezone ?? (() => 'UTC'),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  await engine.start();
  const settings =
    options.settings ?? new SettingsService(db, Buffer.alloc(32).toString('base64'));
  const chat = new AutomationChat({
    db,
    settings,
    engine,
    store,
    events,
    runs: options.runs ?? new AiRunLog(db, events),
    log: pino({ level: 'silent' }),
    ...(options.createConversation !== undefined
      ? { createConversation: options.createConversation }
      : {}),
  });
  return { engine, store, chat };
}
