CREATE TABLE `device_favorites` (
	`device_id` text NOT NULL,
	`member_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_favorites_device_member` ON `device_favorites` (`device_id`,`member_id`);--> statement-breakpoint
CREATE TABLE `zones` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `rooms` ADD `zone_id` text REFERENCES zones(id);--> statement-breakpoint
-- Carry the old shared favorites over to everybody who lives here.
--
-- `devices.favorite` was one flag for the whole home, so the honest reading of
-- an existing pin is "everyone sees this on their dashboard" — give each member
-- their own row rather than picking a winner. On a hub that has just been
-- installed there are no members and no devices yet, and this does nothing.
-- The column itself stays, maintained as the union; see `db/schema.ts`.
INSERT INTO `device_favorites` (`device_id`, `member_id`, `created_at`)
SELECT `devices`.`id`, `members`.`id`, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM `devices` CROSS JOIN `members`
WHERE `devices`.`favorite` = 1;