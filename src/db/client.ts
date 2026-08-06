import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export type Db = ReturnType<typeof createDb>['db'];

/**
 * Open the hub's SQLite file.
 *
 * The pragmas are the whole reason this is a function rather than one line:
 *
 *  - **WAL** so a reader never blocks the writer. The hub reads on every API
 *    request while adapters are writing device state; the default rollback
 *    journal serialises those against each other.
 *  - **synchronous = NORMAL**, which under WAL still survives a process crash
 *    (only a power cut in the wrong millisecond can lose the last commit) and
 *    costs one fsync per checkpoint instead of one per commit. On an SD card
 *    that difference is the difference between a responsive hub and a hub that
 *    stutters every time a sensor reports.
 *  - **busy_timeout**, because better-sqlite3 otherwise throws `SQLITE_BUSY`
 *    immediately, and a checkpoint is enough to collide with.
 *  - **foreign_keys**, which SQLite leaves *off* by default — the schema's
 *    `on delete cascade`/`set null` clauses would silently do nothing.
 *  - a bounded page cache: the 2 MB default is small enough to matter and the
 *    alternative is unbounded, which on a 512 MB board is the wrong direction.
 */
export function createDb(databaseFile: string) {
  mkdirSync(path.dirname(path.resolve(databaseFile)), { recursive: true });

  const sqlite = new Database(databaseFile);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('cache_size = -8000');

  const db = drizzle(sqlite, { schema });
  return {
    db,
    /** Checkpoint and close. Safe to call twice. */
    close: () => {
      if (sqlite.open) {
        sqlite.pragma('wal_checkpoint(TRUNCATE)');
        sqlite.close();
      }
    },
  };
}
