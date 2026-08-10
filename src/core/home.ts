import { eq } from 'drizzle-orm';
import { home } from '../db/schema.js';
import type { Db } from '../db/client.js';

/**
 * The hub's name — which is the home's name, because there is only ever one of
 * each.
 *
 * There used to be two. `GET /hub` answered `HUB_NAME` from the environment,
 * baked into `/etc/gethome/hub.env` at install time and never changed by
 * anybody, while `GET /home` answered a row in the database that the apps could
 * rename. So one machine had a network identity of "GetHome Hub" and a name in
 * the app of "My Home", and renaming it in the app moved one of them: GetHome
 * Studio went on calling it "GetHome Hub" for the life of the hub, and two hubs
 * on one Mac were two rows with the same name. One hub hosts exactly one home
 * and a home cannot move between hubs, so the second name was never a second
 * fact — only a second place for the first one to be wrong.
 *
 * The rule this leaves: **the environment seeds, the database owns.**
 * `HUB_NAME` names a hub that has no name yet, which is a hub booting for the
 * first time; from then on the stored name is what every route, the WebSocket
 * hello and the mDNS advertisement report, and `PATCH /home` is the one way to
 * change it. That is what makes renaming possible at all without a root-owned
 * config rewrite and a restart — the same reason the radio mode lives in the
 * data directory rather than in `hub.env`.
 *
 * The name is held in memory because `GET /hub` is the health check: the
 * installer, Studio and every app poll it, and it must not become a database
 * read per request.
 */
export class HomeService {
  private row: { id: string; name: string } | undefined;

  /**
   * Called after a rename has been written, with the new name.
   *
   * The mDNS advertisement carries the name, and `src/index.ts` owns the
   * advertiser — so this is how a rename reaches it without the API layer
   * importing the responder.
   */
  onRenamed?: (name: string) => void;

  constructor(
    private readonly db: Db,
    /** `HUB_NAME`. Used only when the hub has no stored name yet. */
    private readonly seed: string,
  ) {}

  /** Read the stored name, creating it from the seed on a hub's first boot. */
  async boot(): Promise<void> {
    const existing = await this.db.query.home.findFirst();
    if (existing) {
      this.row = { id: existing.id, name: existing.name };
      return;
    }
    const [created] = await this.db.insert(home).values({ name: this.seed }).returning();
    if (created) this.row = { id: created.id, name: created.name };
  }

  /**
   * The name, and never undefined.
   *
   * Falls back to the seed rather than to an empty string: this answers
   * `GET /hub`, which is public and is what the installer's health check reads,
   * so a database that could not be opened must still produce a hub with a
   * name.
   */
  get name(): string {
    return this.row?.name ?? this.seed;
  }

  /** What `GET /home` returns. */
  snapshot(): { id: string | undefined; name: string } {
    return { id: this.row?.id, name: this.name };
  }

  async rename(name: string): Promise<{ id: string | undefined; name: string }> {
    if (this.row) {
      await this.db.update(home).set({ name }).where(eq(home.id, this.row.id));
      this.row = { ...this.row, name };
    } else {
      // A hub renamed before `boot()` ever found a row — no route can reach
      // this today, but writing the name somewhere is better than dropping it.
      const [created] = await this.db.insert(home).values({ name }).returning();
      if (created) this.row = { id: created.id, name: created.name };
    }
    this.onRenamed?.(this.name);
    return this.snapshot();
  }
}
