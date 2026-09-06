import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Migrations have to stay readable by the build before them.
 *
 * This is not a style rule, it is what makes the installer's automatic rollback
 * work. `install.sh` unpacks the new build, flips the `current` symlink and
 * restarts the hub — and the hub runs its migrations *at boot*
 * (`src/index.ts`), which is **before** the health check that decides whether
 * the new build is any good. So by the time a rollback happens the database has
 * already moved forward, and the symlink flips back into an old build meeting a
 * schema it did not write.
 *
 * While every migration only adds, that is fine: the old build selects the
 * columns it knows and ignores the rest. The moment one drops or renames
 * something, a failed health check stops being recoverable — neither build
 * starts, the automatic rollback lands on a hub that is just as dead, and the
 * only way back is SSH to a Raspberry Pi. That is precisely the evening the
 * rollback exists to save.
 *
 * The rule was written down (`CLAUDE.md`, and the `devices.favorite` column
 * kept on purpose for exactly this reason) and enforced by nothing. Now the
 * only way past it is to say so in the migration itself, which makes dropping
 * something a decision somebody made rather than one drizzle made for them.
 */

const migrationsDir = path.resolve(import.meta.dirname, '../src/db/migrations');

/**
 * The escape hatch. A migration that genuinely has to take something away
 * carries this line, and whoever adds it has to have thought about the build
 * that runs *before* it — usually by shipping the removal one release after the
 * last build that reads the column.
 */
const ALLOW = 'gethome:destructive';

/**
 * Statements that leave the previous build unable to read its own schema.
 *
 * `DROP INDEX` is deliberately not here: an index is an optimisation, and an
 * old build missing one is slower rather than broken.
 */
const DESTRUCTIVE: Array<{ name: string; pattern: RegExp }> = [
  { name: 'DROP TABLE', pattern: /\bDROP\s+TABLE\b/i },
  { name: 'DROP COLUMN', pattern: /\bDROP\s+COLUMN\b/i },
  { name: 'RENAME TO', pattern: /\bRENAME\s+TO\b/i },
  { name: 'RENAME COLUMN', pattern: /\bRENAME\s+COLUMN\b/i },
];

function migrations(): Array<{ file: string; sql: string }> {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, sql: readFileSync(path.join(migrationsDir, file), 'utf8') }));
}

describe('migrations stay readable by the build before them', () => {
  it('finds the migrations at all', () => {
    // A guard that silently checks nothing is worse than no guard: if the
    // folder ever moves, this is what says so instead of passing.
    expect(migrations().length).toBeGreaterThan(0);
  });

  it.each(migrations().map((m) => [m.file, m.sql] as const))(
    '%s only adds, or says why not',
    (file, sql) => {
      if (sql.includes(ALLOW)) return; // Declared, and therefore somebody's call.
      const found = DESTRUCTIVE.filter(({ pattern }) => pattern.test(sql)).map(({ name }) => name);
      expect(
        found,
        `${file} contains ${found.join(', ')}. The hub migrates at boot, before the ` +
          `health check, so a build that fails its check rolls back into a database ` +
          `this has already changed — and if the old build cannot read it either, the ` +
          `rollback lands on a hub that is just as dead and only SSH recovers it. ` +
          `Ship the removal a release after the last build that reads it, or add a ` +
          `"-- ${ALLOW}: <why this is safe>" line if you have thought it through.`,
      ).toEqual([]);
    },
  );
});

/**
 * The journal is the other half of the same story, and nothing was checking it.
 *
 * `meta/_journal.json` is what drizzle actually reads: an ordered list of tags
 * with a `when` beside each, and **the `when` is the only thing that decides
 * whether a migration runs**. `SQLiteSyncDialect.migrate` reads the newest
 * `created_at` out of `__drizzle_migrations` once, then runs every migration
 * whose `when` is greater. It never looks at the hash. So a migration that is
 * *renamed* is a migration drizzle has never seen, whatever it contains — and
 * one given an older `when` than a hub's last applied migration is silently
 * skipped for ever.
 *
 * Both of those arrive the same way: two branches each add an `0012`, one
 * lands first, and the other has to be renumbered on the merge. Git says
 * nothing about it, because the two `.sql` files have different names and merge
 * without a conflict — leaving a repository with two migrations claiming the
 * same index, which is a clean merge that boots wrong. That happened here, and
 * these four assertions are what would have said so.
 *
 * The renumbering itself is unavoidable and correct; what it costs is that a
 * hub which installed the branch under the *old* number already has the change
 * and will meet it again as a new migration. `CLAUDE.md` carries the repair —
 * record it as applied rather than re-running it, since the SQL is the same
 * file under a new name.
 */
describe('the migration journal says what is really there', () => {
  const journal = JSON.parse(
    readFileSync(path.join(migrationsDir, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: Array<{ idx: number; when: number; tag: string }> };

  it('numbers its entries 0…n−1, once each', () => {
    // Two entries at the same index is the shape a merge of two branches that
    // each added a migration takes when nobody renumbers one of them.
    expect(journal.entries.map((entry) => entry.idx)).toEqual(
      journal.entries.map((_, index) => index),
    );
  });

  it('gives every migration a `when` later than the one before it', () => {
    // `when` is the whole gate. A renumbered migration that keeps its old
    // timestamp fixes the hub it was tested on and is skipped on every hub
    // already past that point — the tempting shortcut, and the wrong one.
    const whens = journal.entries.map((entry) => entry.when);
    expect(whens).toEqual([...whens].sort((a, b) => a - b));
    expect(new Set(whens).size).toBe(whens.length);
  });

  it('has a file for every entry, and an entry for every file', () => {
    // Either direction is a rename somebody only half finished: an entry with
    // no file throws on boot, and a file with no entry is a migration that
    // quietly never runs.
    const tagged = journal.entries.map((entry) => `${entry.tag}.sql`).sort();
    const onDisk = migrations().map((migration) => migration.file);
    expect(tagged).toEqual(onDisk);
  });
});
