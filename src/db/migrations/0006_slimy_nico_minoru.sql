CREATE TABLE `mcp_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`member_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`can_control` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_tokens_token_hash_unique` ON `mcp_tokens` (`token_hash`);