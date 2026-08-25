import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { HubEventBus } from '../src/core/bus.js';
import { AccessService, BUILTIN_ROLES, PERMISSION_KEYS } from '../src/core/access.js';
import * as schema from '../src/db/schema.js';

/**
 * What happens to a hub that already has a home in it.
 *
 * The rest of the suite builds its database from every migration at once, so
 * it can only ever say that a *fresh* hub is right. The claim this whole change
 * rests on is the other one: that a hub with an owner and two members, running
 * happily on yesterday's build, wakes up tomorrow able to do exactly what it
 * could yesterday. That has to be proved against real rows written by the old
 * schema, not asserted in prose — so this suite migrates as far as `0003`,
 * writes the members an older build would have written, and only then applies
 * `0004`.
 */
const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'db',
  'migrations',
);

/** The `.sql` files, in the order the journal applies them. */
const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .sort();

/** Apply `migrationFiles[from..to)` — the journal's order, a slice at a time. */
function apply(sqlite: Database.Database, from: number, to: number): void {
  for (const name of migrationFiles.slice(from, to)) {
    const sql = readFileSync(path.join(migrationsDir, name), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) sqlite.exec(trimmed);
    }
  }
}

describe('the roles migration', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('leaves every member with exactly the access they already had', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gethome-migration-'));
    const sqlite = new Database(path.join(dir, 'hub.db'));
    sqlite.pragma('foreign_keys = ON');

    // A hub as it stood before roles existed: everything up to `0003`, and the
    // two words `members.role` could hold.
    apply(sqlite, 0, migrationFiles.length - 1);
    const now = Date.now();
    sqlite
      .prepare('INSERT INTO members (id, name, role, created_at) VALUES (?, ?, ?, ?)')
      .run('11111111-1111-4111-a111-111111111111', 'Georgy', 'owner', now);
    sqlite
      .prepare('INSERT INTO members (id, name, role, created_at) VALUES (?, ?, ?, ?)')
      .run('22222222-2222-4222-a222-222222222222', 'Anna', 'member', now);
    sqlite
      .prepare(
        'INSERT INTO invites (id, code_hash, role, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('33333333-3333-4333-a333-333333333333', 'a'.repeat(64), 'member', now + 900_000, now);

    // …and then the release that adds roles.
    apply(sqlite, migrationFiles.length - 1, migrationFiles.length);

    const db = drizzle(sqlite, { schema });
    const access = new AccessService(db, new HubEventBus());
    await access.load();

    // The owner is still the owner, and still holds everything — including any
    // permission a later build adds, because `can()` never reads their row.
    expect(access.isOwner('11111111-1111-4111-a111-111111111111')).toBe(true);
    expect(access.permissionsFor('11111111-1111-4111-a111-111111111111')).toEqual([
      ...PERMISSION_KEYS,
    ]);

    // The member holds precisely what the routes marked `authed` used to allow,
    // and none of what `ownerOnly` used to refuse.
    const anna = '22222222-2222-4222-a222-222222222222';
    expect(access.roleFor(anna)?.key).toBe('member');
    expect(access.permissionsFor(anna)).toEqual([...BUILTIN_ROLES[1].permissions]);
    for (const wasAuthed of [
      'device.control',
      'device.edit',
      'device.add',
      'home.structure',
      'hub.radio',
    ] as const) {
      expect(access.can(anna, wasAuthed), wasAuthed).toBe(true);
    }
    for (const wasOwnerOnly of [
      'device.remove',
      'home.rename',
      'member.invite',
      'member.remove',
      'hub.ai',
      'role.manage',
    ] as const) {
      expect(access.can(anna, wasOwnerOnly), wasOwnerOnly).toBe(false);
    }

    // An invite minted by the old build still admits somebody as a member.
    const invite = sqlite
      .prepare('SELECT role, role_id FROM invites LIMIT 1')
      .get() as { role: string; role_id: string | null };
    expect(invite.role).toBe('member');
    expect(invite.role_id).toBe(access.builtinRoleId('member'));

    sqlite.close();
  });

  /**
   * `install.sh` flips back to the previous release when a new build fails its
   * health check — by which time this migration has already run — and that
   * build reads `members.role` on every authenticated request. So the column
   * stays, and every write through here has to keep it true.
   */
  it('keeps the legacy role word in step, so a rollback still signs people in', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gethome-migration-'));
    const sqlite = new Database(path.join(dir, 'hub.db'));
    sqlite.pragma('foreign_keys = ON');
    apply(sqlite, 0, migrationFiles.length);

    const id = '44444444-4444-4444-a444-444444444444';
    sqlite
      .prepare('INSERT INTO members (id, name, role, created_at) VALUES (?, ?, ?, ?)')
      .run(id, 'Kolya', 'member', Date.now());

    const db = drizzle(sqlite, { schema });
    const access = new AccessService(db, new HubEventBus());
    await access.load();

    const guest = access.builtinRoleId('guest')!;
    await access.assignRole(id, guest);
    const row = sqlite.prepare('SELECT role, role_id FROM members WHERE id = ?').get(id) as {
      role: string;
      role_id: string;
    };
    expect(row.role_id).toBe(guest);
    // A build that has never heard of a guest reads the permissive word, which
    // lasts only as long as the failed update. The alternative — dropping the
    // column — is a hub nobody can sign in to at all.
    expect(row.role).toBe('member');

    sqlite.close();
  });
});
