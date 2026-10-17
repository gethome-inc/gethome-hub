CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`hint` text NOT NULL,
	`control` integer DEFAULT false NOT NULL,
	`permissions` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`last_used_from` text,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `api_keys_member` ON `api_keys` (`member_id`);--> statement-breakpoint
-- `hub.apikeys` joins the member's set, on the argument every key in that row
-- was put there by: the person who wants their own software to reach the hub
-- is the one standing in the house, and the owner is usually Studio's Mac.
-- Guest is untouched.
--
-- The default alone reaches no hub that already exists — `ensureBuiltins()`
-- inserts with `ON CONFLICT DO NOTHING` — which is why this is here and not
-- only in `access.ts`, exactly as `0006` did for `hub.ai` and `0017` for
-- `hub.wifi`. Idempotent, and it cannot undo a decision a home has made: the
-- key is new, so no one has ever taken it out of this row.
UPDATE `roles`
SET `permissions` = json_insert(`permissions`, '$[#]', 'hub.apikeys')
WHERE `key` = 'member' AND `builtin` = 1 AND `permissions` NOT LIKE '%hub.apikeys%';
