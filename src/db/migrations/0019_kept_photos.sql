-- The photos a home, or one person, chose to keep (`src/photos/`). Three new
-- tables and nothing else: no column is added to an existing table, so the
-- build before this one reads every row it ever did, and a rollback leaves
-- these tables behind untouched until the next update finds them again. What
-- an older build cannot do is release a photo when it deletes a drawing — the
-- newer build's `PhotoStore.reconcile()` does that at its next boot.
CREATE TABLE `kept_photo_uses` (
	`photo_id` text NOT NULL,
	`use_id` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`photo_id`, `use_id`),
	FOREIGN KEY (`photo_id`) REFERENCES `kept_photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `kept_photo_uses_use` ON `kept_photo_uses` (`use_id`);--> statement-breakpoint
CREATE TABLE `kept_photos` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`member_id` text,
	`member_name` text,
	`ref` text,
	`media_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`width` integer,
	`height` integer,
	`at` integer NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `kept_photos_subject` ON `kept_photos` (`kind`,`subject_id`);--> statement-breakpoint
CREATE INDEX `kept_photos_kind_at` ON `kept_photos` (`kind`,`at`);--> statement-breakpoint
CREATE TABLE `member_photo_settings` (
	`member_id` text PRIMARY KEY NOT NULL,
	`keep_chat` integer DEFAULT false NOT NULL,
	`chat_cleared_at` integer,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
