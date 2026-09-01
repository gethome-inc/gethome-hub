CREATE TABLE `automation_chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`at` integer NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`data` text,
	`member_id` text,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `automation_chat_session` ON `automation_chat_messages` (`session_id`,`at`);--> statement-breakpoint
ALTER TABLE `ai_runs` ADD `automation_id` text;