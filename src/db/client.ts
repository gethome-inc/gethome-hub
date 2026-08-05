import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = ReturnType<typeof createDb>['db'];

export function createDb(databaseUrl: string, poolSize = 4) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: poolSize });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
