import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { HomeService } from '../../src/core/home.js';
import {
  activity,
  aiMappings,
  aiRuns,
  devices,
  endpoints,
  home,
  invites,
  members,
  rooms,
  settings,
  tokens,
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
  await db.delete(devices);
  await db.delete(members);
  await db.delete(rooms);
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
