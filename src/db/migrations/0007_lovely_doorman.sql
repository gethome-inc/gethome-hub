CREATE TABLE `ai_run_exchanges` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`at` integer NOT NULL,
	`duration_ms` integer,
	`provider` text NOT NULL,
	`model_id` text NOT NULL,
	`status` integer,
	`ok` integer DEFAULT false NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`sent` text NOT NULL,
	`received` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `ai_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_run_exchanges_run_idx` ON `ai_run_exchanges` (`run_id`,`seq`);