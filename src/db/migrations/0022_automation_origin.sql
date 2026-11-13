ALTER TABLE `automations` ADD `origin` text;--> statement-breakpoint
-- How a rule reached the hub was never a column. It survives only as the note
-- on the version written when the rule was created — `written in chat`, or
-- `from <template key>` — and ten versions are kept per rule, so that note is
-- the first thing an often-edited rule loses. These two statements read what
-- is still there before anything else evicts it. No edit writes either note,
-- so a row carrying one belongs to a rule that was created that way.
--
-- A rule whose first note is the plain `created` is left null on purpose:
-- that note was written for a document sent with a member's own sign-in and
-- for one sent with an API key alike, and guessing which would be a claim.
-- So is a rule whose first version has already gone. Null reads as "this hub
-- does not know how", and `created_by` still says who.
--
-- Additive: it fills a column the build before this one never selects.
UPDATE `automations`
SET `origin` = json_object('kind', 'chat')
WHERE `origin` IS NULL
  AND `id` IN (SELECT `automation_id` FROM `automation_versions` WHERE `note` = 'written in chat');--> statement-breakpoint
UPDATE `automations`
SET `origin` = (
  SELECT json_object('kind', 'template', 'template', substr(`automation_versions`.`note`, 6))
  FROM `automation_versions`
  WHERE `automation_versions`.`automation_id` = `automations`.`id`
    AND `automation_versions`.`note` LIKE 'from _%'
  ORDER BY `automation_versions`.`at`
  LIMIT 1
)
WHERE `origin` IS NULL
  AND `id` IN (SELECT `automation_id` FROM `automation_versions` WHERE `note` LIKE 'from _%');
