CREATE TABLE `automation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`automation_id` text NOT NULL,
	`at` integer NOT NULL,
	`trigger` text NOT NULL,
	`cause` text NOT NULL,
	`outcome` text NOT NULL,
	`duration_ms` integer,
	`steps` text NOT NULL,
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `automation_runs_automation` ON `automation_runs` (`automation_id`,`at`);--> statement-breakpoint
CREATE TABLE `automation_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`automation_id` text NOT NULL,
	`at` integer NOT NULL,
	`document` text NOT NULL,
	`member_id` text,
	`note` text,
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `automation_versions_automation` ON `automation_versions` (`automation_id`,`at`);--> statement-breakpoint
CREATE TABLE `automations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`active` integer DEFAULT false NOT NULL,
	`disabled_reason` text,
	`document` text NOT NULL,
	`created_by` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `automations_enabled` ON `automations` (`enabled`);