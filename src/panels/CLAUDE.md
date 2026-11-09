# `src/panels/` — panels on devices' pages

Loaded when Claude works with files under `src/panels/`. `docs/api.md`
(*Panels*) is canonical and `docs/security.md` says what a panel is to the
home; update them in the same change.

- **One collection for every kind of panel, and the id is the device's.** A
  panel is a card made for a device, and its `kind` says how the apps draw it.
  `web` (a few files of HTML) is the only kind; the next one is a word added to
  `PANEL_KINDS` with its own checks, stored in the same `device_panels` table
  under the same ids, with the same routes. **Never a second table, a second
  route family or a second wire field for a new kind**: an app may key
  anything it remembers about a panel — where somebody put it, whether it is
  folded — on its id alone, so two collections with their own ids would be two
  panels nobody could tell apart. Whoever or whatever made a panel is not a
  kind either: a panel a person's tool installed and one the hub made itself
  would be one collection too.
- **`kind` is an open word on the wire and a closed one on the way in.** The
  apps read it as a string and leave a kind they don't draw off the page, so a
  newer kind never breaks an older app. The hub refuses a kind it doesn't keep
  (`400 unsupported_panel_kind`) rather than storing what it cannot check, and
  says which kinds it keeps in `GET /hub`'s `panels.kinds` — a client offers a
  kind only where that names it. A row of a kind this build doesn't know (a
  newer build wrote it, then the hub rolled back) is loaded, listed and served
  as it was, never dropped.
- **A panel is code that runs on every phone in the house**, so this directory
  is mostly bounds: an id matching `PANEL_ID_PATTERN`, and for a `web` panel at
  most 64 files and 512 KB decoded, `index.html` required, every path checked
  by `pathProblem` (letters, digits, `.`, `_`, `-`; no `..`, nothing hidden,
  four parts at most, nothing under `_app/`, which the apps serve inside every
  panel) and of a type in `TYPES`, strict base64 (`Buffer.from` silently skips
  what it can't read, which is why `isStrictBase64` exists); four panels a
  device of every kind together, 20 MB a hub, and no write below 64 MB free.
  What a panel may *do* on a phone — no network, only its own device's
  commands — is each app's panel host; the hub's half is what it stores and
  serves.
- **Serve from the manifest, never the filesystem.** `file()` finds the path in
  the stored manifest and only then reads it, so a crafted path can't reach
  anything but the panel's own files whatever is on disk, and every answer's
  type comes from the manifest rather than from sniffing. The route
  (`…/panels/:panelId/files/*`) adds `nosniff`, `no-cache` with the file's
  SHA-256 as a strong ETag, and a CSP allowing no network.
- **An identical upload writes nothing** — not a file, not a row, not an
  activity line, not a frame. Tools install on every run, and the card is the
  thing being protected. A real change is written to a staging folder and
  swapped in by rename, so a phone never loads half of each.
- **`GET /devices` reads an in-memory index**, loaded at boot and kept current
  by every write, because `deviceWire` is synchronous and builds the wire device
  by device — the favorites pattern. A device with no panels carries no
  `panels` key at all, so every other wire is byte-for-byte what it was.
- **A change is a `panelsChanged` bus event, not `deviceUpserted`.** The
  socket turns it into each connection's own `deviceUpserted` frame; emitting
  the real bus event would make automations reload everything for a panel.
- **The rows go with their device by cascade, the files do not** — the
  `deviceRemoved` listener deletes the folder, and a new kind that stores
  files here needs the same.
- **Hubs installed from this branch before panels had a `kind` keep an unused
  `device_web_blocks` table and `<data>/web-blocks/` folder.** `0019` was
  rewritten in place while nothing released had it — a later `when`, so such a
  hub runs it again, and `CREATE TABLE IF NOT EXISTS`, so running it twice is
  harmless — and their panels are installed again by the next run of whatever
  made them. Nothing reads the old table; it costs a few kilobytes.
