import { and, eq } from 'drizzle-orm';
import { deviceFavorites, devices } from '../db/schema.js';
import type { Db } from '../db/client.js';
import type { HubEventBus } from './bus.js';

/**
 * Who has pinned what.
 *
 * A favorite used to be a boolean on the device row, which quietly made it a
 * property of the *home*: pinning the kettle put it on everybody's dashboard,
 * and the next person to unpin it took it off yours. Names and rooms are shared
 * because they describe the house; a favorite describes a person. So it is
 * keyed by member, and `GET /devices` answers a different `favorite` to each
 * caller — the wire field is unchanged, which is what lets an app that predates
 * this keep working without noticing.
 *
 * Held in memory and written through, like the home's name and for the same
 * reason: this is read once per device on every `GET /devices` and again on
 * every `deviceUpserted` frame, and a home with three members and forty devices
 * is a few hundred bytes. The rows are the record; the map is the answer.
 *
 * Both foreign keys cascade, so SQLite removes a departed member's pins and a
 * removed device's pins for us. `forgetDevice`/`forgetMember` keep the map in
 * step with the deletes the database has already done.
 */
export class FavoritesService {
  private readonly byMember = new Map<string, Set<string>>();

  constructor(
    private readonly db: Db,
    events: HubEventBus,
  ) {
    // A device can leave without anybody asking this service: a Zigbee device
    // dropped from the network reaches the registry, not the API. The rows go
    // with the cascade either way; this is what keeps the map from holding a
    // pin on a device that no longer exists for the life of the process.
    events.on('deviceRemoved', (deviceId) => this.forgetDevice(deviceId));
  }

  /** Load every pin into memory. Called once, at boot. */
  async load(): Promise<void> {
    this.byMember.clear();
    const rows = await this.db.query.deviceFavorites.findMany();
    for (const row of rows) {
      const set = this.byMember.get(row.memberId);
      if (set) set.add(row.deviceId);
      else this.byMember.set(row.memberId, new Set([row.deviceId]));
    }
  }

  isFavorite(memberId: string, deviceId: string): boolean {
    return this.byMember.get(memberId)?.has(deviceId) ?? false;
  }

  /**
   * Pin or unpin one device for one member.
   *
   * Idempotent on purpose — an app that re-sends the state it already has must
   * not produce a duplicate row or a spurious write.
   */
  async set(memberId: string, deviceId: string, favorite: boolean): Promise<void> {
    const set = this.byMember.get(memberId) ?? new Set<string>();
    if (favorite === set.has(deviceId)) return;

    if (favorite) {
      set.add(deviceId);
      this.byMember.set(memberId, set);
      await this.db.insert(deviceFavorites).values({ deviceId, memberId }).onConflictDoNothing();
    } else {
      set.delete(deviceId);
      if (set.size === 0) this.byMember.delete(memberId);
      else this.byMember.set(memberId, set);
      await this.db
        .delete(deviceFavorites)
        .where(and(eq(deviceFavorites.deviceId, deviceId), eq(deviceFavorites.memberId, memberId)));
    }

    await this.mirrorLegacyColumn(deviceId);
  }

  /** Drop a removed device from every member's set (the rows cascaded). */
  forgetDevice(deviceId: string): void {
    for (const [memberId, set] of this.byMember) {
      if (!set.delete(deviceId)) continue;
      if (set.size === 0) this.byMember.delete(memberId);
    }
  }

  /** Drop a departed member's set (their rows cascaded with the member row). */
  forgetMember(memberId: string): void {
    this.byMember.delete(memberId);
  }

  /**
   * Keep `devices.favorite` equal to "somebody has this pinned".
   *
   * Nothing in this build reads that column. It is maintained because
   * `install.sh` rolls back to the previous release when a new build fails its
   * health check — by which time this schema is already on disk — and the build
   * it rolls back to reads `favorite` on every device query. Leaving it frozen
   * would strand those hubs on whatever was pinned the day they updated; the
   * union is the closest true statement an older build can render.
   */
  private async mirrorLegacyColumn(deviceId: string): Promise<void> {
    let pinnedBySomebody = false;
    for (const set of this.byMember.values()) {
      if (set.has(deviceId)) {
        pinnedBySomebody = true;
        break;
      }
    }
    await this.db.update(devices).set({ favorite: pinnedBySomebody }).where(eq(devices.id, deviceId));
  }
}
