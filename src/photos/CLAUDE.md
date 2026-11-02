# `src/photos/` — the photos a home, or one person, chose to keep

Loaded when Claude works with files under `src/photos/`. `docs/api.md`
(*Photos the hub keeps*) is canonical for the wire — update it in the same
change. The root `CLAUDE.md` carries the one rule here that binds code outside
this directory.

- **Off until asked twice, and the app's question is the load-bearing one.** A
  photo is kept only when the request that carried it says so (`keepPhotos` on
  a chat message or a room drawing, `keepPhoto` on a portrait) **and** the
  switch for its kind is on — the home's for rooms and portraits (settings keys
  `photos_keep_rooms` / `photos_keep_portraits`, `true` or absent, the
  `update_automatic` pattern), the sender's own for chat
  (`member_photo_settings.keep_chat`). The switch alone is not enough because
  every shipped iPhone build, every shipped Studio and the Privacy Policy said
  photos stay on the device that took them: an app that never asks is an app
  whose sentence stays true, and the hub cannot tell an old app from a new one
  any other way. Never keep a photo on the switch alone.
- **Room, never a board.** Keeping is gated on the data partition keeping more
  than `PHOTOS_MIN_FREE_BYTES` (2 GiB) free *after* the write, with a pause that
  lifts only at `PHOTOS_RESUME_FREE_BYTES` so a hub on the line does not flap.
  2 GiB sits far above the 500 MB where portraits and room pictures stop
  drawing, so photos always stop first and never cost the home a drawing. A
  photo lives on the card, not in memory, so a 512 MB board with a big card
  keeps photos exactly as a Pi 5 does — the radio budget's rule from the other
  side: measure the machine, never name it. **A pause deletes nothing.**
- **A photo lives as long as what it was kept for.** `kept_photo_uses` is the
  whole of its lifetime: a room picture, a portrait or a chat message, and the
  photo goes with the last of them (`release`). One photo can serve several,
  because drawing again from kept photos is why they are kept. The services that
  remove drawings call `release` themselves, a removed room or device calls
  `forgetSubject`, `endMembership` calls `forgetMember` (chat photos only — a
  room photo somebody took stays the house's, with their name), and
  `reconcile()` at boot answers anything an older build removed after a
  rollback — and leaves the rows alone when it cannot list the folder, since
  only a folder that is not there has no files, and a read that failed would
  otherwise read every row as missing. **A drawing made again from kept photos
  is attached to them before the prune that makes room for it** — in both
  services — or the prune, finding a photo used only by the drawing it is
  taking, deletes it out from under the new one; and `attach` never throws,
  answering the ids it attached. Chat photos also age out by their own `at` after
  `CHAT_PHOTO_RETAIN_DAYS`, which a suite holds equal to
  `RETAIN_TRANSCRIPT_DAYS`, and past `CHAT_PHOTOS_BUDGET_BYTES` the oldest go.
- **The same photo again is the copy already kept.** A room drawn again from
  the photos the phone that took them still has sends the same bytes a second
  time, and writing them again would keep one walk round the room once per
  drawing — five sets, and a count on the app's page five times the truth.
  `keep()` compares each room or portrait photo against the subject's kept
  photos of the same size (`keptCopyOf`, a read only where the length matches)
  and attaches the copy it finds to the new use instead. That is only sound
  because a photo is stored exactly as it was sent: re-encode one and the
  comparison silently stops finding anything. It costs no room, so it happens
  even while keeping is paused. **Chat photos are never compared** — each is
  its sender's, for one message.
- **The sweep is on a clock**, unlike the activity log's prune: "kept for 14
  days" is a promise about somebody's pictures, and a quiet hub must keep it.
  Hourly, unref'd, started by `src/index.ts` and never by a suite.
- **Storing is not processing.** Write the buffer the route already decoded —
  no copy, no re-encode, no thumbnail, no image library — tmp-then-rename,
  `0600`. A chat message's photos are decoded and written **one at a time**,
  because the base64 is already held for the round on a board with thirty
  megabytes to spare. Drawing again reads kept files instead of a base64 body,
  which costs less memory than the first drawing did, never more.
- **Keeping is not sending.** Nothing here reaches a provider, and nothing that
  reaches a provider reads from here except a drawing somebody asked to make
  again (`keptPhotoIds`, `keptPhotoId`). A chat photo is sent for its one round
  and never again — not on a retry, a recap, a revival or a handoff.
- **Who sees what.** A chat photo is its sender's alone: `GET /photos/:id` is a
  `404` to anybody else, the owner included, so it does not even exist for
  them. Room and portrait photos are the house's, for whoever holds `hub.ai`
  (the key that draws them). Every route is `memberOnly` — no API key reaches a
  photo, reading included — and `test/api-keys.test.ts` holds that.
- **Never throws into the job.** `keep()` answers `{ids, outcome}` and catches
  everything: a photo that could not be kept is a photo that stays where it
  was, which is how every photo worked before this, so a drawing or a message
  must never fail on it. `outcome.reason` is an open word (`off`, `low-space`,
  `failed`) the routes hand back as `photosKept`.
