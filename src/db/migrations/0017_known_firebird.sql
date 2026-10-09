CREATE TABLE `device_web_blocks` (
	`device_id` text NOT NULL,
	`block_id` text NOT NULL,
	`title` text NOT NULL,
	`sha256` text NOT NULL,
	`bytes` integer NOT NULL,
	`height` integer NOT NULL,
	`manifest` text NOT NULL,
	`updated_at` integer NOT NULL,
	`member_id` text,
	`member_name` text,
	PRIMARY KEY(`device_id`, `block_id`),
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- `camera.view` joins the member's set, `hub.ai`'s path in `0006`: the default
-- in `access.ts` reaches no hub that already exists, because `ensureBuiltins()`
-- inserts with `ON CONFLICT DO NOTHING` and an existing `member` row keeps the
-- set it was created with. Idempotent, and it overrides no decision a home has
-- made: `camera.view` is new, so no one has ever taken it out. Guest is left
-- alone — a camera shows people, and that is the home's call to make for
-- somebody staying.
UPDATE `roles`
SET `permissions` = json_insert(`permissions`, '$[#]', 'camera.view')
WHERE `key` = 'member' AND `builtin` = 1 AND `permissions` NOT LIKE '%camera.view%';
