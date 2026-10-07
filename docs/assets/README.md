# Assets

The pictures the [README](../../README.md) shows. They are **copies**: the
originals live in the gethome website, where they were already public before
they came here.

| File | What it is | Copied from | On |
|---|---|---|---|
| `mark.png` | the gethome app icon, 144 × 144 | the website's `public/icons/mark.png` | 2026-09-29 |
| `screens/home-{light,dark}.webp` | the app's Home pane (a demo home) | the website's `public/screens/` | 2026-09-29 |
| `screens/assistant-{light,dark}.webp` | the assistant as it opens | the website's `public/screens/` | 2026-09-29 |
| `screens/device-{light,dark}.webp` | a lamp's device page (a demo home) | the website's `public/screens/` | 2026-09-29 |
| `app-store-badge.svg` | Apple's "Download on the App Store" badge, black, US English | developer.apple.com, as Apple publishes it — not the website, which shows Apple's white one on its dark close | 2026-10-06 |

The copies are byte-identical to the originals (sha256 of `mark.png`
`c7189519…`, of `screens/home-dark.webp` `583bd493…`, of `app-store-badge.svg`
`a26fc5b3…`).

## Rules

- **A screen is a capture of the running app, and it stays untouched.** No
  crop, no annotation, no device frame, no drawn-in UI. A picture of a screen
  the app does not have is a promise the app does not keep.
- **Replace, don't accumulate.** When the app's interface changes, the old
  capture shows something the product no longer does: replace the file and the
  date above. Git keeps the old one.
- **The hub has no screen of its own.** These are the *app's*; the README
  captions them that way. Two are of a demo home, so nothing here should be
  described as "the hub's interface".
- **No text baked into an image.** The wordmark in the README is real text, so
  it follows the reader's theme, can be selected and is read out by a screen
  reader. Apple's badge is the one exception, because Apple's rules make it
  one: it is Apple's artwork, used as published — never redrawn, recoloured,
  cropped or animated — linked to the app's own App Store page, and shown once.
  Its alt text says what it says.
