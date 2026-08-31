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
CREATE INDEX `automations_enabled` ON `automations` (`enabled`);--> statement-breakpoint
-- `automation.manage` joins the member's set, for the third time on the
-- `hub.update` argument. A rule is bounded (the engine's guards hold whatever
-- it says, whoever wrote it), reversible (switch it off, or revert the
-- document) and named in the activity log — which is the three-part test for
-- what belongs in a default. And the person who notices that the hall light
-- should come on when somebody walks past is the person standing in the hall,
-- not the laptop in the drawer that happens to hold Owner.
--
-- Guest is untouched, and the line is exactly where it should be: anybody may
-- *press* "I'm leaving", because working the home is the floor and no role
-- takes it away — this is only about who may change what pressing it does.
--
-- The default alone reaches no hub that already exists (`ensureBuiltins()`
-- inserts with `ON CONFLICT DO NOTHING`), which is why the update is here as
-- well as in `access.ts`. Idempotent, and it cannot contradict a decision a
-- home has made: the key has never existed, so nobody has ever removed it.
UPDATE `roles`
SET `permissions` = json_insert(`permissions`, '$[#]', 'automation.manage')
WHERE `key` = 'member' AND `builtin` = 1 AND `permissions` NOT LIKE '%automation.manage%';
