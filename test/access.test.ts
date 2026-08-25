import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AccessService, BUILTIN_ROLES, PERMISSION_KEYS } from '../src/core/access.js';
import { HubEventBus } from '../src/core/bus.js';
import { members, roles } from '../src/db/schema.js';
import { openTestDb, resetDb } from './helpers/db.js';

const handle = await openTestDb();

/**
 * `AccessService` on its own, with no server in front of it.
 *
 * `test/roles.test.ts` proves the guards from the outside, which is where a
 * regression would be *felt*; this is where the answers those guards read come
 * from, and several of them cannot be reached over HTTP at all — a role row a
 * newer build wrote, a member row an older one wrote, a member whose row is
 * already gone.
 */
describe.skipIf(!handle)('access service', () => {
  const db = handle?.db!;
  let events: HubEventBus;

  /** Insert a member row directly — the shape the pairing flow leaves behind. */
  const addMember = async (
    name: string,
    row: { role: string; roleId?: string | null },
  ): Promise<string> => {
    const [inserted] = await db
      .insert(members)
      .values({ name, role: row.role, roleId: row.roleId ?? null })
      .returning();
    return inserted!.id;
  };

  const loaded = async (): Promise<AccessService> => {
    const access = new AccessService(db, events);
    await access.load();
    return access;
  };

  beforeEach(async () => {
    await resetDb(db);
    events = new HubEventBus();
  });

  afterAll(async () => {
    await handle?.close();
  });

  // ── The owner ─────────────────────────────────────────────────────────────

  /**
   * The owner is answered without a stored set being read. That is the whole
   * of why a permission a *later* build adds is theirs the moment they update,
   * and why `role.manage` can be handed out with no escalation guard: there is
   * nothing an edited matrix can do to the one row that is never consulted.
   */
  it('answers the owner without reading a stored set', async () => {
    const access = await loaded();
    const owner = await addMember('Georgy', {
      role: 'owner',
      roleId: access.builtinRoleId('owner'),
    });
    access.noteMember(owner, access.builtinRoleId('owner'));

    // Empty the owner's stored row behind the service's back, then reload — so
    // the answers below come from a table that grants nothing at all.
    await db.update(roles).set({ permissions: [] }).where(eq(roles.key, 'owner'));
    const reloaded = await loaded();

    expect(reloaded.isOwner(owner)).toBe(true);
    for (const key of PERMISSION_KEYS) {
      expect(reloaded.can(owner, key), key).toBe(true);
    }
    expect(reloaded.permissionsFor(owner)).toEqual([...PERMISSION_KEYS]);
  });

  // ── Rows written by another build ─────────────────────────────────────────

  /**
   * The rollback case the whole design rests on: `install.sh` puts the previous
   * release back when a build fails its health check, so this build can meet a
   * role row a *newer* one wrote. A permission it cannot enforce must be
   * ignored rather than trusted — and the row must survive, so rolling forward
   * restores it rather than silently revoking what somebody granted.
   */
  it('ignores a permission key a newer build stored, and leaves the row holding it', async () => {
    await db
      .update(roles)
      .set({ permissions: ['device.control', 'hub.timetravel', 'activity.read'] })
      .where(eq(roles.key, 'guest'));

    const access = await loaded();
    const guest = access.roleByKeyName('guest')!;
    expect(guest.permissions).toEqual(['device.control', 'activity.read']);

    const stored = await db.query.roles.findFirst({ where: eq(roles.key, 'guest') });
    expect(stored?.permissions).toContain('hub.timetravel');
  });

  /** Order is the catalog's, and duplicates and non-strings are not permissions. */
  it('normalizes a stored set to catalog order, without duplicates or junk', async () => {
    await db
      .update(roles)
      .set({ permissions: ['activity.read', 'device.control', 'activity.read', 7, null] })
      .where(eq(roles.key, 'guest'));

    const access = await loaded();
    expect(access.roleByKeyName('guest')!.permissions).toEqual([
      'device.control',
      'activity.read',
    ]);
  });

  /**
   * A member row written before `role_id` existed resolves through the legacy
   * word, which is what makes the migration's backfill a convenience rather
   * than something correctness depends on — a hub restored from an old backup
   * comes up with everybody in the right place.
   */
  it('resolves a member row that predates role_id through the legacy word', async () => {
    const access = await loaded();
    const oldOwner = await addMember('Georgy', { role: 'owner', roleId: null });
    const oldMember = await addMember('Anna', { role: 'member', roleId: null });

    const reloaded = await loaded();
    expect(reloaded.isOwner(oldOwner)).toBe(true);
    expect(reloaded.roleFor(oldMember)?.key).toBe('member');
    expect(reloaded.can(oldMember, 'home.structure')).toBe(true);
    expect(reloaded.can(oldMember, 'home.rename')).toBe(false);
    // And `hub.update` is on the member side of that line, so a phone that
    // could update this hub before roles existed still can.
    expect(reloaded.can(oldMember, 'hub.update')).toBe(true);
  });

  // ── Members coming and going ──────────────────────────────────────────────

  /**
   * A member id nobody has ever noted is not a member. `roleFor` falls back to
   * the default role — which is what lets a legacy row resolve — so an id that
   * is simply wrong would otherwise come back holding Member's permissions.
   */
  it('gives a stranger the default role and nothing the owner has', async () => {
    const access = await loaded();
    expect(access.roleFor('nobody-at-all')?.key).toBe('member');
    expect(access.isOwner('nobody-at-all')).toBe(false);
    expect(access.can('nobody-at-all', 'home.rename')).toBe(false);
  });

  /**
   * `forgetMember` is the in-memory half of a delete the database has already
   * done by cascade. Skipping it leaks two ways: `GET /roles` keeps counting a
   * member who has left, and `DELETE /roles/:id` keeps refusing `role_in_use`
   * for a role nobody wears — which is unfixable from any app, since there is
   * nobody left to move out of it.
   */
  it('stops counting a member who has left, and frees the role they wore', async () => {
    const access = await loaded();
    const custom = await access.createRole('Cleaner', ['device.control']);
    const kolya = await addMember('Kolya', { role: 'member', roleId: custom.id });
    await access.assignRole(kolya, custom.id);

    expect(access.list().find((role) => role.id === custom.id)?.memberCount).toBe(1);
    expect(await access.deleteRole(custom.id)).toBe('role_in_use');

    await db.delete(members).where(eq(members.id, kolya));
    access.forgetMember(kolya);

    expect(access.list().find((role) => role.id === custom.id)?.memberCount).toBe(0);
    expect(await access.deleteRole(custom.id)).toBeNull();
  });

  /** A claim with no role named lands in Member — what every claim used to be. */
  it('puts a member with no role named into the default role', async () => {
    const access = await loaded();
    const anna = await addMember('Anna', { role: 'member', roleId: null });
    access.noteMember(anna, null);
    expect(access.roleFor(anna)?.key).toBe('member');
    expect(access.permissionsFor(anna)).toEqual([...BUILTIN_ROLES[1]!.permissions]);
  });

  // ── Editing ───────────────────────────────────────────────────────────────

  /**
   * A role with nothing at all is a legitimate thing for a home to make — it
   * is the shape "somebody who can see the house and nothing else" takes — and
   * it must not silently become the default set on the way in.
   */
  it('creates a role with no permissions at all', async () => {
    const access = await loaded();
    const nobody = await access.createRole('Watcher', []);
    expect(nobody.permissions).toEqual([]);
    expect(nobody.builtin).toBe(false);

    const kolya = await addMember('Kolya', { role: 'member', roleId: nobody.id });
    await access.assignRole(kolya, nobody.id);
    for (const key of PERMISSION_KEYS) {
      expect(access.can(kolya, key), key).toBe(false);
    }
  });

  /** The owner's row is refused every way in, so no edit can reach it. */
  it('refuses to edit or delete the owner’s role', async () => {
    const access = await loaded();
    const owner = access.builtinRoleId('owner')!;
    expect(await access.updateRole(owner, { permissions: [] })).toBe('role_is_owner');
    expect(await access.updateRole(owner, { name: 'Boss' })).toBe('role_is_owner');
    expect(await access.deleteRole(owner)).toBe('role_is_owner');
    expect(await access.deleteRole(access.builtinRoleId('guest')!)).toBe('role_is_builtin');
    expect(await access.updateRole('no-such-role', { name: 'x' })).toBe('not_found');
  });

  /**
   * **Every access write announces, and it announces to everybody.**
   *
   * It used to name the members holding the role that changed, which was right
   * about the personal half of the `access` frame (`role`, `permissions`) and
   * wrong about the shared half: the frame also carries `roles`, the whole
   * table with a `memberCount` on every row. So creating a role reached nobody
   * (a new role has no holders), deleting one reached nobody (it is refused
   * while held), and an owner editing Guest heard nothing about their own edit
   * — the matrix they were looking at did not move until the page was closed
   * and reopened. Each socket renders its own frame, so a broadcast is still
   * one answer per member.
   */
  it('announces every access write, to everybody', async () => {
    const access = await loaded();
    const anna = await addMember('Anna', { role: 'member', roleId: access.builtinRoleId('member') });
    access.noteMember(anna, access.builtinRoleId('member'));

    let announced = 0;
    events.on('accessChanged', () => { announced += 1; });

    // A role nobody in this home holds — the case that used to be silent.
    await access.updateRole(access.builtinRoleId('guest')!, { permissions: [] });
    expect(announced).toBe(1);

    await access.updateRole(access.builtinRoleId('member')!, { permissions: ['device.control'] });
    expect(announced).toBe(2);

    // Creating and deleting: no holders by definition, and both change the
    // table every open screen is drawing.
    const custom = await access.createRole('Cleaner', ['device.control']);
    expect(announced).toBe(3);
    expect(await access.deleteRole(custom.id)).toBeNull();
    expect(announced).toBe(4);

    // Assigning moves two `memberCount`s, so it is everybody's business too.
    await access.assignRole(anna, access.builtinRoleId('guest')!);
    expect(announced).toBe(5);
    // And the legacy word moved with it, because a build this hub might roll
    // back to reads that column on every authenticated request.
    const row = await db.query.members.findFirst({ where: eq(members.id, anna) });
    expect(row?.role).toBe('member');
  });

  /**
   * `load()` is idempotent and seeds the built-ins itself, which is what covers
   * a database restored from a backup taken before the roles migration existed.
   */
  it('seeds the built-in roles itself, and running twice changes nothing', async () => {
    await db.delete(roles);
    const access = await loaded();
    expect(access.list().map((role) => role.key)).toEqual(BUILTIN_ROLES.map((role) => role.key));

    await access.load();
    expect(access.list().map((role) => role.key)).toEqual(BUILTIN_ROLES.map((role) => role.key));
  });
});
