-- Panels on devices' pages, every kind in one table (`src/panels/`). Written
-- by hand from what `db:generate` emits, for one reason: `IF NOT EXISTS`. This
-- file replaced `0019_device_web_blocks` before anything released had either,
-- under a later `when`, and was renumbered from `0019_device_panels` to here
-- when `main` took 0019 and 0020 first — with a new `when`, because a hub
-- already past those skips any migration dated before them. So a hub installed
-- from the branch under an earlier number meets this one again, and it has to
-- stay harmless however many times that happens.
CREATE TABLE IF NOT EXISTS `device_panels` (
	`device_id` text NOT NULL,
	`panel_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`sha256` text NOT NULL,
	`bytes` integer NOT NULL,
	`height` integer NOT NULL,
	`manifest` text NOT NULL,
	`updated_at` integer NOT NULL,
	`member_id` text,
	`member_name` text,
	PRIMARY KEY(`device_id`, `panel_id`),
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- `camera.view` joins the member's set, `hub.ai`'s path in `0006` and
-- `hub.wifi`'s in `0017`: the default in `access.ts` reaches no hub that
-- already exists, because `ensureBuiltins()` inserts with
-- `ON CONFLICT DO NOTHING` and an existing `member` row keeps the set it was
-- created with. Idempotent, and it overrides no decision a home has made:
-- `camera.view` is new, so no one has ever taken it out. Guest is left alone —
-- a camera shows people, and that is the home's call to make for somebody
-- staying.
UPDATE `roles`
SET `permissions` = json_insert(`permissions`, '$[#]', 'camera.view')
WHERE `key` = 'member' AND `builtin` = 1 AND `permissions` NOT LIKE '%camera.view%';
