import { eq } from 'drizzle-orm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { HomeService } from '../../src/core/home.js';
import { FavoritesService } from '../../src/core/favorites.js';
import { AccessService } from '../../src/core/access.js';
import type { HubEventBus } from '../../src/core/bus.js';
import {
  activity,
  aiMappings,
  aiRuns,
  deviceFavorites,
  devices,
  endpoints,
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
  await db.delete(tokens);
  await db.delete(invites);
  await db.delete(endpoints);
  await db.delete(deviceFavorites);
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
