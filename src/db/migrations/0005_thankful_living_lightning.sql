-- Recorded readings, so an app can draw what the last few days looked like.
--
-- Two tables and nothing else: this migration only **adds**, which is what
-- keeps `install.sh`'s automatic rollback safe. The hub migrates at boot,
-- *before* the health check that decides whether the new build is any good, so
-- a build that fails lands the old one on a schema it did not write — and the
-- old one simply never selects from these two.
CREATE TABLE `history_series` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_id` text NOT NULL,
	`endpoint_id` integer NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `history_series_device_endpoint_kind` ON `history_series` (`device_id`,`endpoint_id`,`kind`);--> statement-breakpoint
-- **`WITHOUT ROWID` is the whole shape of this table**, and drizzle has no way
-- to say it — so this file is hand-finished and `db:generate` must never be
-- allowed to overwrite it back to a plain table.
--
-- With it, the table *is* the b-tree on `(series_id, bucket)`: no rowid, no
-- second index to write on every insert, and a chart asking for one week of
-- one series reads one contiguous range. A row is roughly twenty bytes, which
-- puts a week of an ordinary home (~30 recorded quantities) at one to two
-- megabytes.
--
-- The cascade is real, unlike `rooms.zone_id` and `members.role_id`: those are
-- columns added by `ALTER TABLE`, which SQLite refuses to attach a referential
-- action to. This is a `CREATE TABLE`, so removing a device really does take
-- its history with it.
CREATE TABLE `history` (
	`series_id` integer NOT NULL,
	`bucket` integer NOT NULL,
	`min` integer NOT NULL,
	`max` integer NOT NULL,
	`sum` integer NOT NULL,
	`n` integer NOT NULL,
	PRIMARY KEY(`series_id`, `bucket`),
	FOREIGN KEY (`series_id`) REFERENCES `history_series`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID;
