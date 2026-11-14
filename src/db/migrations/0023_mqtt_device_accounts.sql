CREATE TABLE `mqtt_device_accounts` (
	`device_id` text PRIMARY KEY NOT NULL,
	`password_hash` text NOT NULL,
	`project_key` text,
	`member_id` text,
	`member_name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
