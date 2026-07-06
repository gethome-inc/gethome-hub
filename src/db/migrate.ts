import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Db } from './client.js';

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
}
