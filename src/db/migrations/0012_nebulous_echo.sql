ALTER TABLE `automation_chat_messages` ADD `surface` text;--> statement-breakpoint
CREATE INDEX `automation_chat_surface` ON `automation_chat_messages` (`surface`,`at`);