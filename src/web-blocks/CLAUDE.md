# `src/web-blocks/` — panels on devices' pages

Loaded when Claude works with files under `src/web-blocks/`. `docs/api.md`
(*Web blocks*) is canonical and `docs/security.md` says what a block is to the
home; update them in the same change.

- **A block is code that runs on every phone in the house**, so this directory
  is mostly bounds: an id matching `BLOCK_ID_PATTERN`, at most 64 files and
  512 KB decoded, `index.html` required, every path checked by `pathProblem`
  (letters, digits, `.`, `_`, `-`; no `..`, nothing hidden, four parts at most)
  and of a type in `TYPES`, strict base64 (`Buffer.from` silently skips what it
  can't read, which is why `isStrictBase64` exists), four blocks a device, 20 MB
  a hub, and no write below 64 MB free. What a block may *do* on a phone — no
  network, only its own device's commands — is each app's web-block host; the
  hub's half is what it stores and serves.
- **Serve from the manifest, never the filesystem.** `file()` finds the path in
  the stored manifest and only then reads it, so a crafted path can't reach
  anything but the block's own files whatever is on disk, and every answer's
  type comes from the manifest rather than from sniffing. The route adds
  `nosniff`, `no-cache` with the file's SHA-256 as a strong ETag, and a CSP
  allowing no network.
- **An identical upload writes nothing** — not a file, not a row, not an
  activity line, not a frame. Tools install on every run, and the card is the
  thing being protected. A real change is written to a staging folder and
  swapped in by rename, so a phone never loads half of each.
- **`GET /devices` reads an in-memory index**, loaded at boot and kept current
  by every write, because `deviceWire` is synchronous and builds the wire device
  by device — the favorites pattern. A device with no blocks carries no
  `webBlocks` key at all, so every other wire is byte-for-byte what it was.
- **A change is a `webBlocksChanged` bus event, not `deviceUpserted`.** The
  socket turns it into each connection's own `deviceUpserted` frame; emitting
  the real bus event would make automations reload everything for a panel.
- **The rows go with their device by cascade, the files do not** — the
  `deviceRemoved` listener deletes the folder, and a new kind of file stored
  here needs the same.
