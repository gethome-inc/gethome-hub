import { sql } from 'drizzle-orm';
import { createDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://gethome:gethome@127.0.0.1:5432/gethome';

export interface TestDb {
  db: Db;
  close: () => Promise<void>;
}

/**
 * Connect to the test Postgres (docker compose up -d postgres) and migrate.
 * Returns null when the database is unreachable so suites can skip cleanly.
 */
export async function openTestDb(): Promise<TestDb | null> {
  const { db, pool } = createDb(TEST_DATABASE_URL);
  try {
    await pool.query('select 1');
  } catch {
    await pool.end().catch(() => {});
    return null;
  }
  await runMigrations(db);
  return { db, close: () => pool.end() };
}

/** Wipe all data between tests, keeping the schema. */
export async function resetDb(db: Db): Promise<void> {
  await db.execute(sql`
    truncate table activity, tokens, invites, members, endpoints, devices,
      rooms, home, ai_mappings, settings restart identity cascade
  `);
}
