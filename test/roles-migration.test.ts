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

/**
 * Where the roles migration sits in that list.
 *
 * **Named, not counted.** This was `migrationFiles.length - 1` — "the last
 * one" — which was true on the day it was written and quietly stopped being
 * true the next time anything was added: the suite then wrote its old-build
 * members *after* the roles migration had already run and backfilled, and
 * failed on an invite whose `role_id` nothing had filled in. A suite about one
 * migration has to say which one.
 */
const ROLES_MIGRATION = migrationFiles.findIndex((name) => name.startsWith('0004_')) + 1;

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
    apply(sqlite, 0, ROLES_MIGRATION - 1);
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

    // …and then the release that adds roles, and everything since. The claim
    // is about what an old hub ends up holding *today*, so it has to be
    // evaluated at HEAD: `0006` grants `hub.ai` to the member row this
    // migration created, and stopping at `0004` would leave that unproven.
    apply(sqlite, ROLES_MIGRATION - 1, migrationFiles.length);

    const db = drizzle(sqlite, { schema });
    const access = new AccessService(db, new HubEventBus());
    await access.load();

    // The owner is still the owner, and still holds everything — including any
    // permission a later build adds, because `can()` never reads their row.
    expect(access.isOwner('11111111-1111-4111-a111-111111111111')).toBe(true);
    expect(access.permissionsFor('11111111-1111-4111-a111-111111111111')).toEqual([
      ...PERMISSION_KEYS,
    ]);

    // The member holds what the routes marked `authed` used to allow, plus the
    // two keys deliberately moved since — `hub.update` and `hub.ai`, both for
    // the same reason: the owner is a Mac in a drawer, so owner-only meant the
    // phone in somebody's hand could never do it at all.
    const anna = '22222222-2222-4222-a222-222222222222';
    expect(access.roleFor(anna)?.key).toBe('member');
    expect(access.permissionsFor(anna)).toEqual([...BUILTIN_ROLES[1].permissions]);
    for (const wasAuthed of [
      'device.edit',
      'device.add',
      'home.structure',
      'hub.radio',
      // `POST /system/update` was `authed` too by the time this landed, and a
      // phone that could update the hub yesterday has to be able to today.
      'hub.update',
      // `hub.ai` never was, and is the one thing this migration *changes*
      // rather than preserves. It is granted by an `UPDATE` because
      // `ensureBuiltins()` would not reach a row that already exists — which
      // is exactly the case this suite is set up to reproduce.
      'hub.ai',
    ] as const) {
      expect(access.can(anna, wasAuthed), wasAuthed).toBe(true);
    }
    // Working a device is the floor now rather than a key, so nobody holds it
    // and the commands route asks only for a token.
    expect(PERMISSION_KEYS).not.toContain('device.control' as never);
    for (const wasOwnerOnly of [
      'device.remove',
      'home.rename',
      'member.invite',
      'member.remove',
      'role.manage',
      // Newer than the old guards — the broker took anonymous connections when
      // they were written — and still withheld from Member by default, because
      // a broker password is a secret that leaves the building and removing a
      // member cannot take it back. Here for the same reason as the rest: a
      // hub upgrading into this build must not quietly hand every phone in the
      // home a credential nobody granted them.
      'hub.mqtt',
      'hub.mqtt.admin',
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
