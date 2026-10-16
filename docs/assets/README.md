# Assets

The pictures the [README](../../README.md) shows. Each was already public
before it came here: the icon and the app's screens on the gethome website,
the badge on Apple's.

| File | What it is | Copied from | On |
|---|---|---|---|
| `mark.png` | the gethome app icon, 144 × 144 | the website's `public/icons/mark.png` | 2026-09-29 |
| `app-store-badge.svg` | Apple's "Download on the App Store" badge, black, US English | developer.apple.com, as Apple publishes it — not the website, which shows Apple's white one on its dark close | 2026-10-06 |
| `screens/home-{light,dark}.webp` | the app's Home pane for the City Apartment demo home, in a drawn iPhone frame | the website's `public/screens/` as of 2026-10-01, framed (below) | 2026-10-16 |
| `screens/assistant-{light,dark}.webp` | the assistant as it opens, in a drawn iPhone frame | the website's `public/screens/` as of 2026-09-29, framed | 2026-10-16 |
| `screens/device-{light,dark}.webp` | a lamp's device page (the older Studio demo home), in a drawn iPhone frame | the same | 2026-10-16 |

`mark.png` and the badge are byte-identical to the originals (sha256
`c7189519…` and `a26fc5b3…`). The framed screens are made from the website's
captures by a script in the gethome marketing repository, which is private and
is where the tooling for pictures like these lives; neither the script nor the
bare captures are kept here.

## Rules

- **A screen is a capture of the running app, and it stays untouched.** No
  crop, no annotation, no drawn-in UI. A picture of a screen the app does not
  have is a promise the app does not keep.
- **The frame goes around a capture, never into it.** The README shows each
  screen in an iPhone frame (the owner's call, 2026-10-16). The rule this
  replaces, written with this folder on 2026-09-29, listed a device frame beside
  crops and drawn-in UI, but its own reason — a screen the app does not have —
  is true only of those two: a frame changes nothing inside the capture, and it
  is how the App Store, Product Hunt and X pictures already show the app.
  The capture is placed pixel for pixel — never scaled, cropped or redrawn —
  with the bezel, the band, the side buttons and the shadow drawn around it.
  The one thing drawn over the capture is the **Dynamic Island**, because an
  iPhone frame without one reads as a diagram: it sits on the blank middle of
  the status bar, where iOS leaves room for it in every screenshot, and the
  script refuses a capture with anything drawn there. The frame is plain drawn
  shapes, not Apple's product artwork, and no Apple mark is in it.
- **Replace, don't accumulate.** When the app's interface changes, the old
  capture shows something the product no longer does: have the framed set made
  again from what the website shows, and move the dates above. Never edit a
  framed file by hand. Git keeps the old ones.
- **The hub has no screen of its own.** These are the *app's*; the README
  captions them that way. Two are of a demo home, so nothing here should be
  described as "the hub's interface".
- **No text baked into an image.** The wordmark in the README is real text, so
  it follows the reader's theme, can be selected and is read out by a screen
  reader. Apple's badge is the one exception, because Apple's rules make it
  one: it is Apple's artwork, used as published — never redrawn, recoloured,
  cropped or animated — linked to the app's own App Store page, and shown once.
  Its alt text says what it says.
