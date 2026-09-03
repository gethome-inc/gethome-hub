import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { invites, members, roles } from '../db/schema.js';
import type { HubEventBus } from './bus.js';

/**
 * Who may do what in this home.
 *
 * Access used to be one comparison — `member.role !== 'owner'` — which meant
 * the only knob anybody had was which side of the owner line a whole route sat
 * on, and moving it moved it for everyone. Roles are rows now, permissions are
 * a named vocabulary, and the mapping between the two is a table the home
 * edits from either app.
 *
 * Three ideas hold it together, and each is load-bearing:
 *
 * 1. **The floor is not a permission.** Reading the home, renaming yourself,
 *    leaving, and pinning your own favorites are what *being a member* means.
 *    They are not in the catalog and no role can take them away, because a
 *    member with nothing at all is a token that can only 401 behind an app
 *    that cannot draw a single screen.
 * 2. **The owner is never evaluated.** `can()` answers `true` for the owner
 *    without reading a stored set. So a permission added by a later hub build
 *    is the owner's automatically, and no edit to any table can lock a home
 *    out of itself — which is the safety net that lets `role.manage` be handed
 *    to anybody without an escalation guard behind it.
 * 3. **The defaults reproduce what the hub did before roles existed.** The
 *    `member` set below is, line for line, the routes that were `authed`; the
 *    keys missing from it are the ones that were `ownerOnly`. Upgrading a hub
 *    therefore changes nothing at all until somebody edits the matrix — and
 *    that is a claim `test/roles.test.ts` proves rather than asserts.
 *
 * Held in memory and written through, like `FavoritesService` and the home's
 * name: `can()` runs on every authenticated request, a home has a handful of
 * roles, and this machine's disk is an SD card.
 */

/** One entry of the catalog the apps render their matrix from. */
export interface PermissionDescriptor {
  key: PermissionKey;
  /** Which block of the matrix this belongs in. */
  group: 'Devices' | 'Home' | 'People' | 'Hub';
  title: string;
  summary: string;
}

/**
 * The vocabulary, and **the hub owns its wording**.
 *
 * `GET /permissions` hands these strings to the apps, which render them rather
 * than shipping copy of their own. It is the `activity.message` rule applied to
 * a list that will grow: an app one version behind still draws a complete,
 * truthful matrix instead of a row labelled with a key nobody can read. What
 * an app *does* hard-code is the handful of keys it gates its own UI on.
 */
export const PERMISSIONS: readonly PermissionDescriptor[] = [
  {
    key: 'device.edit',
    group: 'Devices',
    title: 'Rename and move devices',
    summary:
      'Change what a device is called and which room it is in. Everybody in the home sees the result.',
  },
  {
    key: 'device.add',
    group: 'Devices',
    title: 'Add devices',
    summary: 'Pair a Matter accessory, or open the Zigbee network so a new device can join.',
  },
  {
    key: 'device.remove',
    group: 'Devices',
    title: 'Remove devices',
    summary: 'Take a device out of the home and unpair it. Nothing in the apps undoes this.',
  },
  {
    key: 'home.structure',
    group: 'Home',
    title: 'Change rooms and zones',
    summary:
      'Add, rename, restyle and delete rooms and zones. A deleted room keeps its devices.',
  },
  {
    key: 'home.rename',
    group: 'Home',
    title: 'Rename the home',
    summary: 'The name everybody sees, and the one this hub answers to on the network.',
  },
  {
    key: 'activity.read',
    group: 'Home',
    title: 'See the whole home’s activity',
    summary:
      'Read what everybody did, by name. Without this, only your own actions are visible.',
  },
  {
    key: 'automation.manage',
    group: 'Home',
    title: 'Create and change automations',
    summary:
      'Write the rules the home runs by itself — schedules, sensors, and the buttons and modes ' +
      'on the dashboard. Everybody can press them; this is who can change what they do.',
  },
  {
    key: 'member.invite',
    group: 'People',
    title: 'Invite people',
    summary: 'Create an invite code so somebody can join this home.',
  },
  {
    key: 'member.remove',
    group: 'People',
    title: 'Remove people',
    summary: 'End somebody’s access straight away, on every device they signed in with.',
  },
  {
    key: 'role.manage',
    group: 'People',
    title: 'Manage roles',
    summary:
      'Change what each role can do, and which role each person has. Anyone with this can give it away.',
  },
  {
    key: 'hub.radio',
    group: 'Hub',
    title: 'Switch the radio',
    summary: 'Choose whether this hub runs Zigbee or Matter, on a board that runs one at a time.',
  },
  {
    key: 'hub.update',
    group: 'Hub',
    title: 'Update the hub',
    summary:
      'Install a newer build when one exists. The home is offline for a few minutes while it happens.',
  },
  {
    key: 'hub.ai',
    group: 'Hub',
    title: 'AI keys and portraits',
    summary:
      'The API keys and the adaptation switch, drawing a device portrait, what has been spent, and the device-mapping library.',
  },
  {
    key: 'hub.mqtt',
    group: 'Hub',
    title: 'Connect your own devices over MQTT',
    summary:
      'See the username and password for wiring a board or an integration into this home. ' +
      'That account can publish your own devices and read what the home reports, but not ' +
      'control Zigbee devices or open the network for pairing.',
  },
  {
    key: 'hub.mqtt.admin',
    group: 'Hub',
    title: 'Full access to the MQTT broker',
    summary:
      'See the hub’s own broker password, which can control every Zigbee device directly ' +
      'and open the network for pairing. Worth having for debugging; it is the keys to the home.',
  },
] as const;

export type PermissionKey =
  | 'device.edit'
  | 'device.add'
  | 'device.remove'
  | 'home.structure'
  | 'home.rename'
  | 'activity.read'
  | 'automation.manage'
  | 'member.invite'
  | 'member.remove'
  | 'role.manage'
  | 'hub.radio'
  | 'hub.update'
  | 'hub.ai'
  | 'hub.mqtt'
  | 'hub.mqtt.admin';

export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSIONS.map((entry) => entry.key);

const KNOWN_KEYS = new Set<string>(PERMISSION_KEYS);

/** The three roles every hub has, and what they may do out of the box. */
export const BUILTIN_ROLES = [
  {
    key: 'owner',
    name: 'Owner',
    sortOrder: 0,
    /**
     * Stored for display only. `can()` never reads it — see the owner rule at
     * the top of this file — so this list going stale costs nothing, which is
     * exactly why the owner is safe from a future permission being forgotten.
     */
    permissions: [...PERMISSION_KEYS],
  },
  {
    key: 'member',
    name: 'Member',
    sortOrder: 1,
    /**
     * Precisely the routes that were `authed` before roles existed.
     *
     * `hub.update` is in here for the reason it stopped being owner-only in
     * the first place: GetHome Studio claims a hub as *the Mac*, so the owner
     * is a laptop in a drawer and every phone joins by invite — owner-only
     * there did not mean "an update needs care", it meant the phone in the
     * owner's own hand could never update their own hub, ever.
     *
     * `automation.manage` is here on the same reading of who lives in a home.
     * A rule is bounded (the engine's guards hold whatever it says), reversible
     * (switch it off, or revert the document), and named in the activity log —
     * the three-part test for a default. The person who notices the hall light
     * should come on when somebody walks past is the person standing in the
     * hall, and making them ask a laptop in a drawer is the trap `hub.update`
     * fell into. Guest is where the line falls: somebody staying the weekend
     * may press "I'm leaving" — that is the floor — and has no business
     * rewriting what it does.
     *
     * `hub.ai` joined it later on exactly that argument. It spends money, which
     * is a real reason for care and not a reason for owner-only: the person
     * standing in the house is the one who wants a device recognised or a
     * portrait drawn, and on a typical hub that person is never the owner.
     * Guest is where the line actually falls. Adding a key to this list does
     * not reach a hub that already exists — `ensureBuiltins()` inserts with
     * `ON CONFLICT DO NOTHING` — so it travels with a migration that updates
     * the stored row (`0006`).
     *
     * **Neither MQTT key is here, and that is the one place the "bounded
     * cost" test comes out differently.** Every other permission is a request
     * this hub carries out and can stop carrying out: removing a member takes
     * their tokens with the row and hangs up the socket they were holding, so
     * whatever they could do, they cannot do a second later. A broker password
     * is not like that — it is a secret that leaves the building. Nothing here
     * can un-tell somebody a password, and the only way to take one back is to
     * mint another and go round every board in the house that had it. Handing
     * one out is therefore the owner's call by default, exactly as it would be
     * for a front-door key. A home that wants it otherwise says so in the
     * matrix, and `hub.mqtt` alone is the safe half of the answer: it is the
     * account that cannot switch anything on.
     */
    permissions: [
      'device.edit',
      'device.add',
      'home.structure',
      'activity.read',
      'automation.manage',
      'hub.radio',
      'hub.update',
      'hub.ai',
    ] as PermissionKey[],
  },
  {
    key: 'guest',
    name: 'Guest',
    sortOrder: 2,
    /**
     * Somebody staying in the house — and a role with **no keys at all**, which
     * is the honest shape of it rather than an oversight.
     *
     * They work the lights and keep their own favorites, because both of those
     * are the *floor* and no role grants or withholds them: an app whose whole
     * job is switching things on cannot have a member who may not switch
     * anything on. What a guest does not get is everything above that line —
     * they change no names, open no network, take the home offline for nobody,
     * and read only their own line in the activity log.
     *
     * Guest is the one place the "defaults change nothing" claim looks like it
     * bends, and it doesn't: every member who exists today becomes **Member**
     * and keeps everything they had, `hub.update` included. Guest is a role
     * that did not exist, so it takes nothing from anybody.
     */
    permissions: [] as PermissionKey[],
  },
] as const;

export const OWNER_ROLE_KEY = 'owner';
const DEFAULT_ROLE_KEY = 'member';

export interface RoleRecord {
  id: string;
  key: string;
  name: string;
  builtin: boolean;
  permissions: PermissionKey[];
  sortOrder: number;
}

/** A role plus how many people hold it — what `DELETE /roles/:id` guards on. */
export interface RoleWire extends RoleRecord {
  memberCount: number;
}

export type RoleRefusal = 'role_is_owner' | 'role_is_builtin' | 'role_in_use' | 'not_found';

/** Keep only keys this build understands, in catalog order, without duplicates. */
function normalizePermissions(raw: unknown): PermissionKey[] {
  const wanted = new Set(
    Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : [],
  );
  return PERMISSION_KEYS.filter((key) => wanted.has(key));
}

export class AccessService {
  private readonly byId = new Map<string, RoleRecord>();
  private readonly byKey = new Map<string, RoleRecord>();
  /**
   * Which role each member holds — the one thing `can()` needs that is not on
   * the role itself. Mirrors `FavoritesService.byMember`: loaded once, kept in
   * step with the writes that pass through here, and pruned by `forgetMember`
   * when the row goes, so it never holds a role for somebody who has left.
   */
  private readonly roleByMember = new Map<string, string>();

  constructor(
    private readonly db: Db,
    private readonly events: HubEventBus,
  ) {}

  /**
   * Read the table into memory, creating the built-in roles if this hub has
   * never had them.
   *
   * The migration seeds them too. Doing it again here is what covers a hub
   * whose database was created before the roles migration *and* restored from a
   * backup, and it is idempotent — `key` is unique.
   */
  async load(): Promise<void> {
    await this.ensureBuiltins();
    this.byId.clear();
    this.byKey.clear();
    for (const row of await this.db.query.roles.findMany()) {
      const record: RoleRecord = {
        id: row.id,
        key: row.key,
        name: row.name,
        builtin: row.builtin,
        permissions: normalizePermissions(row.permissions),
        sortOrder: row.sortOrder,
      };
      this.byId.set(record.id, record);
      this.byKey.set(record.key, record);
    }

    this.roleByMember.clear();
    for (const row of await this.db.query.members.findMany()) {
      // A row written by a build older than this column resolves through the
      // legacy word, which is what makes the migration's backfill a
      // convenience rather than something correctness depends on.
      const roleId = row.roleId ?? this.byKey.get(legacyKey(row.role))?.id;
      if (roleId) this.roleByMember.set(row.id, roleId);
    }
  }

  private async ensureBuiltins(): Promise<void> {
    for (const builtin of BUILTIN_ROLES) {
      await this.db
        .insert(roles)
        .values({
          key: builtin.key,
          name: builtin.name,
          builtin: true,
          permissions: [...builtin.permissions],
          sortOrder: builtin.sortOrder,
        })
        .onConflictDoNothing();
    }
  }

  // ── Asking ────────────────────────────────────────────────────────────────

  /**
   * May this member do this?
   *
   * The owner is answered without reading anything, which is the whole of why
   * a home cannot be locked out of itself and why a permission this build has
   * never heard of is still theirs.
   */
  can(memberId: string, permission: PermissionKey): boolean {
    const role = this.roleFor(memberId);
    if (!role) return false;
    if (role.key === OWNER_ROLE_KEY) return true;
    return role.permissions.includes(permission);
  }

  isOwner(memberId: string): boolean {
    return this.roleFor(memberId)?.key === OWNER_ROLE_KEY;
  }

  /**
   * How many people hold the owner role.
   *
   * Owner is an ordinary role now — it can be invited into, assigned and taken
   * away — and this is the one thing left holding the old rule up. A home that
   * loses its last owner is one nobody can ever configure again: no route
   * grants the role, because granting it is itself owner-only, so there would
   * be nobody left who could put it right. Everything else about owning a home
   * opens up; this does not.
   *
   * Counted from the in-memory map rather than the table, like everything else
   * `can()` reads, and `forgetMember` is what keeps it honest when somebody
   * leaves.
   */
  ownerCount(): number {
    const ownerRoleId = this.byKey.get(OWNER_ROLE_KEY)?.id;
    if (!ownerRoleId) return 0;
    let count = 0;
    for (const roleId of this.roleByMember.values()) {
      if (roleId === ownerRoleId) count += 1;
    }
    return count;
  }

  /** Whether moving or removing this member would leave the home ownerless. */
  isLastOwner(memberId: string): boolean {
    return this.isOwner(memberId) && this.ownerCount() <= 1;
  }

  roleFor(memberId: string): RoleRecord | undefined {
    const roleId = this.roleByMember.get(memberId);
    return roleId ? this.byId.get(roleId) : this.byKey.get(DEFAULT_ROLE_KEY);
  }

  /** What this member may do, as the apps receive it. The owner gets the lot. */
  permissionsFor(memberId: string): PermissionKey[] {
    const role = this.roleFor(memberId);
    if (!role) return [];
    return role.key === OWNER_ROLE_KEY ? [...PERMISSION_KEYS] : [...role.permissions];
  }

  role(id: string): RoleRecord | undefined {
    return this.byId.get(id);
  }

  roleByKeyName(key: string): RoleRecord | undefined {
    return this.byKey.get(key);
  }

  builtinRoleId(key: string): string | undefined {
    return this.byKey.get(key)?.id;
  }

  /** Every role, in display order, each with how many people hold it. */
  list(): RoleWire[] {
    const counts = new Map<string, number>();
    for (const roleId of this.roleByMember.values()) {
      counts.set(roleId, (counts.get(roleId) ?? 0) + 1);
    }
    return [...this.byId.values()]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .map((role) => ({ ...role, memberCount: counts.get(role.id) ?? 0 }));
  }

  // ── Writing ───────────────────────────────────────────────────────────────

  /** Remember a member the pairing flow has just created. */
  noteMember(memberId: string, roleId: string | null | undefined): void {
    const resolved = roleId ?? this.byKey.get(DEFAULT_ROLE_KEY)?.id;
    if (resolved) this.roleByMember.set(memberId, resolved);
  }

  /** Their row is gone (the cascade did it); this is the in-memory half. */
  forgetMember(memberId: string): void {
    this.roleByMember.delete(memberId);
  }

  async createRole(name: string, permissions: unknown): Promise<RoleRecord> {
    const sortOrder =
      Math.max(0, ...[...this.byId.values()].map((role) => role.sortOrder)) + 1;
    const [row] = await this.db
      .insert(roles)
      .values({
        key: `custom-${crypto.randomUUID()}`,
        name,
        builtin: false,
        permissions: normalizePermissions(permissions),
        sortOrder,
      })
      .returning();
    if (!row) throw new Error('role insert returned nothing');
    const record: RoleRecord = {
      id: row.id,
      key: row.key,
      name: row.name,
      builtin: row.builtin,
      permissions: normalizePermissions(row.permissions),
      sortOrder: row.sortOrder,
    };
    this.byId.set(record.id, record);
    this.byKey.set(record.key, record);
    this.announce();
    return record;
  }

  /**
   * Rename a role, change what it may do, or both.
   *
   * The owner's row is refused: `can()` does not read it, so editing it would
   * be a control that changes a number on a screen and nothing in the world —
   * and the one that *looks* like it could take `role.manage` away from the
   * only person guaranteed to have it.
   */
  async updateRole(
    id: string,
    patch: { name?: string | undefined; permissions?: unknown },
  ): Promise<RoleRecord | RoleRefusal> {
    const existing = this.byId.get(id);
    if (!existing) return 'not_found';
    if (existing.key === OWNER_ROLE_KEY) return 'role_is_owner';

    const next: RoleRecord = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.permissions !== undefined
        ? { permissions: normalizePermissions(patch.permissions) }
        : {}),
    };
    await this.db
      .update(roles)
      .set({ name: next.name, permissions: next.permissions })
      .where(eq(roles.id, id));
    this.byId.set(id, next);
    this.byKey.set(next.key, next);
    this.announce();
    return next;
  }

  /**
   * Delete a custom role.
   *
   * Refused while anybody holds it. `members.role_id` carries no `ON DELETE`
   * action — SQLite cannot attach one to a column added by `ALTER TABLE` — so
   * this check *is* the referential integrity, and the plain foreign key
   * behind it is what refuses if this ever forgets. Silently reassigning
   * somebody's access is not an option worth having.
   *
   * **An outstanding invite is not somebody holding it, and it goes with the
   * role.** `invites.role_id` is the same kind of column and the same missing
   * action, so a code minted into this role would otherwise make the delete
   * fail on a raw foreign key — a 500 for what is an ordinary thing to do.
   * The two ways out of that are not equal. Clearing the column would let the
   * code admit its holder as a plain **Member**, which is an escalation
   * nobody asked for and the exact silent reassignment the paragraph above
   * refuses. Refusing the delete would be a dead end: no route revokes an
   * invite, so a home that made a role, invited somebody into it and changed
   * its mind would be told `role_in_use` about a role nobody wears, with
   * nothing to do but wait out the expiry. So the codes go. An invite's whole
   * content is "join as this" — with the role gone it means nothing, it lives
   * fifteen minutes, and minting another is one tap. Used and expired rows go
   * too: nothing reads their role, and deleting the row cannot resurrect a
   * code, since `claim` finds an invite by its hash and a row that isn't there
   * is simply not a code.
   */
  async deleteRole(id: string): Promise<RoleRefusal | null> {
    const existing = this.byId.get(id);
    if (!existing) return 'not_found';
    if (existing.key === OWNER_ROLE_KEY) return 'role_is_owner';
    if (existing.builtin) return 'role_is_builtin';
    if (this.membersHolding(id).length > 0) return 'role_in_use';
    await this.db.delete(invites).where(eq(invites.roleId, id));
    await this.db.delete(roles).where(eq(roles.id, id));
    this.byId.delete(id);
    this.byKey.delete(existing.key);
    this.announce();
    return null;
  }

  /**
   * Put a member in a role.
   *
   * Also writes the legacy `members.role` word, because a build this hub might
   * roll back to reads that column on every authenticated request — see the
   * comment on the column itself.
   */
  async assignRole(memberId: string, roleId: string): Promise<RoleRecord | undefined> {
    const role = this.byId.get(roleId);
    if (!role) return undefined;
    await this.db
      .update(members)
      .set({ roleId, role: legacyWord(role.key) })
      .where(eq(members.id, memberId));
    // Everyone, because `roles` carries a `memberCount` per row: moving one
    // person between two roles changes two of those numbers, on every screen
    // showing the table.
    this.roleByMember.set(memberId, roleId);
    this.announce();
    return role;
  }

  private membersHolding(roleId: string): string[] {
    const held: string[] = [];
    for (const [memberId, held_] of this.roleByMember) {
      if (held_ === roleId) held.push(memberId);
    }
    return held;
  }

  /**
   * Tell every open socket that the access picture moved.
   *
   * A role edit has to reach an app that is already open, or somebody watches
   * a screen full of controls that have quietly stopped working — the same
   * argument that put `structure` and `hubStatus` on the socket.
   *
   * **Everyone, not only the members holding the role that changed**, and that
   * is not a widening for its own sake: the `access` frame carries `roles` —
   * the whole table, each row with its `memberCount` — beside this member's own
   * `role` and `permissions`. The first half is a *shared* fact and the second
   * is personal, and announcing only to holders got the personal half right
   * while leaving the shared half stale everywhere else. Which meant: a role
   * somebody created reached nobody at all (a new role has no holders), a role
   * they deleted the same (it is refused while held), and an owner editing
   * Guest heard nothing about their own edit, because the owner does not hold
   * Guest. The matrix on the screen they were looking at simply did not move
   * until the page was closed and reopened.
   *
   * Each socket renders its own frame, so a broadcast is not a leak: everybody
   * still gets their own answer, and the role table is the floor to read
   * anyway. It costs one in-memory `list()` per open socket on an event that
   * happens when a person edits a role.
   */
  private announce(): void {
    this.events.emit('accessChanged');
  }

  /** Which members hold a role — used when a role's own permissions move. */
  async membersWithRole(roleId: string): Promise<string[]> {
    const rows = await this.db.query.members.findMany({ where: eq(members.roleId, roleId) });
    return rows.map((row) => row.id);
  }

  /** Names for a set of member ids, for an activity sentence. */
  async namesOf(memberIds: string[]): Promise<string[]> {
    if (memberIds.length === 0) return [];
    const rows = await this.db.query.members.findMany({ where: inArray(members.id, memberIds) });
    return rows.map((row) => row.name);
  }
}

/** The legacy column understands two words; everything that isn't the owner is a member. */
function legacyWord(roleKey: string): string {
  return roleKey === OWNER_ROLE_KEY ? 'owner' : 'member';
}

function legacyKey(role: string): string {
  return role === OWNER_ROLE_KEY ? OWNER_ROLE_KEY : DEFAULT_ROLE_KEY;
}
