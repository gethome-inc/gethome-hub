CREATE TABLE `roles` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`builtin` integer DEFAULT false NOT NULL,
	`permissions` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roles_key_unique` ON `roles` (`key`);--> statement-breakpoint
ALTER TABLE `invites` ADD `role_id` text REFERENCES roles(id);--> statement-breakpoint
ALTER TABLE `members` ADD `role_id` text REFERENCES roles(id);--> statement-breakpoint
-- The three roles every hub has, with the sets that reproduce exactly what it
-- did before roles existed: `member` is, key for key, the routes that were
-- `authed`, and the keys missing from it are the ones that were `ownerOnly`.
-- So this migration changes nothing at all until somebody edits the matrix —
-- the claim `test/roles.test.ts` proves rather than asserts.
--
-- The owner's list is stored for display only. `AccessService.can` answers
-- `true` for the owner without reading it, which is what hands a permission
-- added by a later build to the owner automatically and makes a home
-- impossible to lock itself out of.
--
-- `AccessService.load()` inserts these too, with `ON CONFLICT DO NOTHING`, so a
-- database restored from a backup taken before this migration still comes up
-- with its roles. Doing it in both places is deliberate: neither is the kind of
-- thing that should depend on the other having run.
INSERT INTO `roles` (`id`, `key`, `name`, `builtin`, `permissions`, `sort_order`, `created_at`)
VALUES (
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-a' ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  'owner', 'Owner', 1,
  '["device.control","device.edit","device.add","device.remove","home.structure","home.rename","activity.read","member.invite","member.remove","role.manage","hub.radio","hub.update","hub.ai"]',
  0, CAST(strftime('%s', 'now') AS INTEGER) * 1000
) ON CONFLICT (`key`) DO NOTHING;--> statement-breakpoint
-- `hub.update` is the one key here that was never `ownerOnly` *or* `authed` for
-- long: it arrived owner-only and was opened to every member within a day, once
-- a real hub showed what "owner" means — Studio claims a hub as the Mac, so the
-- owner is a laptop in a drawer and the phone in somebody's hand could never
-- update their own home. Giving it to `member` is therefore the same statement
-- as every other key in this row: what a member could already do. Guest is the
-- role that did not exist, so it takes nothing from anybody.
INSERT INTO `roles` (`id`, `key`, `name`, `builtin`, `permissions`, `sort_order`, `created_at`)
VALUES (
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-a' ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  'member', 'Member', 1,
  '["device.control","device.edit","device.add","home.structure","activity.read","hub.radio","hub.update"]',
  1, CAST(strftime('%s', 'now') AS INTEGER) * 1000
) ON CONFLICT (`key`) DO NOTHING;--> statement-breakpoint
-- Somebody staying in the house: they work the lights and keep their own
-- favorites, change no names, open no network, and read only their own line in
-- the activity log.
INSERT INTO `roles` (`id`, `key`, `name`, `builtin`, `permissions`, `sort_order`, `created_at`)
VALUES (
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-a' ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  'guest', 'Guest', 1, '["device.control"]',
  2, CAST(strftime('%s', 'now') AS INTEGER) * 1000
) ON CONFLICT (`key`) DO NOTHING;--> statement-breakpoint
-- Everybody who is already in this home keeps exactly the access they had.
-- `members.role` stays beside `role_id` and is maintained from now on, because
-- `install.sh` flips back to the previous release when a build fails its health
-- check and that build reads this column on every authenticated request.
UPDATE `members`
SET `role_id` = (SELECT `id` FROM `roles` WHERE `roles`.`key` = CASE WHEN `members`.`role` = 'owner' THEN 'owner' ELSE 'member' END)
WHERE `role_id` IS NULL;--> statement-breakpoint
UPDATE `invites`
SET `role_id` = (SELECT `id` FROM `roles` WHERE `roles`.`key` = CASE WHEN `invites`.`role` = 'owner' THEN 'owner' ELSE 'member' END)
WHERE `role_id` IS NULL;
