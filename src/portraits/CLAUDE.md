# `src/portraits/` — device portraits

Loaded when Claude works with files under `src/portraits/`. The rule that key
material never leaves the hub is in the root `CLAUDE.md` with the other
secrets. `docs/portraits.md` is canonical — update it in the same change.

- **A device's portrait is the house's, so the hub draws it and keeps it**
  (`src/portraits/`, `docs/portraits.md` is canonical). The app used to do this
  with a key in its own Keychain and the images in its own storage, which made a
  picture one phone's: a second person opened the same kettle and saw a grey
  sphere. Four rules. **The bytes are files, the record is a row** —
  `<data>/portraits/<device>/<id>.png` beside a `device_portraits` row, because
  a 1024² PNG through the WAL is the write amplification the rest of the store
  is arranged to avoid. **This is not the `STATE_FLUSH_MS` case**: every other
  bound here is about write *frequency*, and a portrait is one deliberate write
  per press — so it gets a bound on *bulk* instead (6 per device, 300 MB per
  hub, oldest-unselected first) plus the one thing only a large file needs, a
  refusal to draw below 500 MB free. **A selected portrait is never evicted**,
  and `selected: null` while portraits exist is a *state* — the procedural
  sphere, chosen — rather than an absence, which is what saves a column meaning
  the same thing twice. And **no thumbnails are made here**: that would mean a
  native image library on a 415 MB board for something each app already derives
  and caches. `gpt-image-2.5-flare` is pinned because it supports transparent
  backgrounds, which is the whole point of a cut-out the apps float over their
  own glow — and because it is the *fast* half of the 2.5 pair, on a surface
  where somebody watches an orb until the picture lands. Moving off `gpt-image-2`
  cost nothing at the wire: 2.5 kept the Image API's shape, so it was a model id
  and a re-read of the three facts hanging off it. `quality` stays `high` rather
  than reaching for the `xhigh`/`max` that 2.5 added — transparency is at its
  best at medium or high, and spending the saved time on detail nobody sees at
  card size would undo the reason for moving. **The prompt stopped naming a
  scene** with it (`src/portraits/prompts.ts`): a prompt's instructions take
  priority over `background: transparent`, so "empty space", "no ground plane"
  and "no scenery" were a backdrop described in front of the one capability the
  path exists for. The shadow ban stays — a shadow is something the object casts,
  not a place it is standing in.
  **And the finish and the light were rewritten for a model that obeys**, which is the
  shape to expect from every prompt here written against a looser one: the palette said
  `matte soft-touch`, `gpt-image-2` gave it a sheen anyway, and 2.5 rendered the sentence
  exactly — a dry, chalky body with no highlight and the cobalt down to a few pixels. Not
  a worse render, a *more faithful one to a prompt that asked for the wrong thing*. Matte
  is the highlight's **roll-off** rather than its absence; the cobalt is named as the
  device's **own indicator** rather than a light in the scene, since a lamp with a blue
  studio light on it is a photograph of a different object; and the light now has a
  **direction**, because "soft top light and gentle rim light" names two lights and no
  direction and resolves as flat frontal fill. The three-quarter **angle is on the
  generate path only** — with no photo the model invents the object anyway, while turning
  one on the edit path means inventing the sides the camera never saw.
  **What a drawing cost goes in `ai_runs`; who asked goes on the picture.** A
  portrait is the third thing that spends the home's money on AI, so every draw
  writes one row (`kind: 'portrait'`), failures included with the provider's own
  `errorKind` — that table's argument is that what a home spent is *one*
  question, and three tables would be three screens answering it; `portraitId`
  links the row to what it bought the way `automationId` does for a rule, and
  `finish` times the run so the duration is free. The price is read off the
  response's own `usage`, because 2.5 bills per token and estimating from the
  size we asked for is a guess dressed as a fact — with **no usage meaning no
  price rather than a free one** (`$0.00` is a claim where nothing is the truth)
  and an unsplit input priced at the dearer image rate, since an estimate that
  reads low is the one that surprises somebody. **`drawnBy` is on the portrait
  row** and is not a second copy of the activity log's `device.portrait` line:
  that log is bounded at 5 000 rows and 30 days while a portrait has no age
  bound, and `ai_runs` keeps 250 runs of every kind with a chat writing one per
  turn — so both records of who drew a picture expire while the picture does
  not. The member's *name* rides beside the id for the log's own reason: an
  `ALTER TABLE` column gets no `ON DELETE` action in SQLite, so the id may point
  at somebody long removed.
