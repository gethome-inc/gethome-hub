-- `hub.wifi` joins the member's set, on the `hub.update` argument once more:
-- the person carrying the hub to its new home is rarely the Mac that claimed
-- it, and owner-only would have meant the phone in their hand could never tell
-- the hub where it was going. Guest is untouched.
--
-- The default alone reaches no hub that already exists — `ensureBuiltins()`
-- inserts with `ON CONFLICT DO NOTHING` — which is why this is here and not only
-- in `access.ts`, exactly as `0006` did for `hub.ai`. Idempotent, and it cannot
-- undo a decision a home has made: the key is new, so no one has ever taken it
-- out of this row.
UPDATE `roles`
SET `permissions` = json_insert(`permissions`, '$[#]', 'hub.wifi')
WHERE `key` = 'member' AND `builtin` = 1 AND `permissions` NOT LIKE '%hub.wifi%';
