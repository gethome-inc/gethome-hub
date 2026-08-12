CREATE TABLE `ai_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`adapter` text NOT NULL,
	`vendor` text,
	`model` text,
	`exposes_hash` text NOT NULL,
	`model_id` text,
	`ok` integer DEFAULT false NOT NULL,
	`cost_usd` real,
	`turns` integer,
	`duration_ms` integer,
	`error_kind` text,
	`error_message` text,
	`steps` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `ai_mappings` ADD `source` text DEFAULT 'ai' NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_mappings` ADD `problems` text;--> statement-breakpoint
ALTER TABLE `ai_mappings` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `devices` ADD `recognition` text;