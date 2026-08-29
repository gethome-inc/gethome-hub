CREATE TABLE `device_portraits` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`at` integer NOT NULL,
	`bytes` integer NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`from_photo` integer DEFAULT false NOT NULL,
	`selected` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `device_portraits_device` ON `device_portraits` (`device_id`);--> statement-breakpoint
ALTER TABLE `ai_runs` ADD `provider` text;--> statement-breakpoint
-- `hub.ai` joins the member's set, and this is the `hub.update` argument a
-- second time. It was owner-only because an AI key spends the owner's money —
-- true, and beside the point once you ask who the owner *is*: Studio claims a
-- hub as the Mac, so the owner is a laptop in a drawer and every phone joins by
-- invite, which meant the phone in somebody's own hand could never add a key to
-- their own home, and the app's whole AI page would have been invisible to
-- everybody who lives there. Guest is untouched: a key is money, and somebody
-- staying the weekend has no business spending it.
--
-- The default alone would reach no hub that already exists — `ensureBuiltins()`
-- inserts with `ON CONFLICT DO NOTHING`, so an existing `member` row keeps the
-- set it was created with — which is why this update is here and not only in
-- `access.ts`. It is idempotent, and it cannot contradict a decision a home has
-- made: `hub.ai` was never in this row, so no one has ever taken it out.
UPDATE `roles`
SET `permissions` = json_insert(`permissions`, '$[#]', 'hub.ai')
WHERE `key` = 'member' AND `builtin` = 1 AND `permissions` NOT LIKE '%hub.ai%';
