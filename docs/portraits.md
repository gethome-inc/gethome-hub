# Device portraits

An AI-drawn picture of a device — the floating object the GetHome app shows on
a device's page, in place of a tinted icon. The hub draws it, stores it, and
serves it to every member of the home.

`docs/api.md` is canonical for the wire
([routes](api.md#device-portraits) and the
[settings answer](api.md#the-ai-settings-answer)); this file is the module.

## Why the hub draws it

The app used to do this itself, with an OpenAI key in the phone's Keychain and
the images in its own Application Support. That made a portrait **one phone's**:
a second person in the same home opened the same kettle and saw a grey sphere.

A device's picture is the house's, exactly like its name and its room, so it
belongs where those live. Two things follow from moving it here rather than
sharing the key:

- **The key never leaves the hub.** Handing it to a phone so the phone could
  draw would break the rule every credential in this repo is held to — the API
  never returns key material.
- **The prompt is the hub's too**, which is what makes portraits *identical*
  between apps and versions. The hub already knows the device's canonical
  `kind`, so a caller sends nothing but "draw this device", optionally with a
  photo to restyle. There is no prompt on the wire.

Homes with no hub are unchanged: the GetHome app keeps its Keychain key and its
local store for Apple Home exports and demo homes, and says so.

## The prompts (`src/portraits/prompts.ts`)

Ported from the app, unchanged in substance:

- **From the kind** — a noun per canonical device kind ("modern smart table
  lamp", "round robot vacuum"), because "draw a `wallSwitch`" is not English and
  the model draws the category it recognises.
- **From a photo** — recreate *this* object and restyle only its finish. It
  deliberately never names the kind: what somebody points a camera at may be the
  lamp an outlet feeds, and the render has to be that lamp rather than a stock
  outlet.

Both are palette-locked (matte graphite body, one cobalt accent) and both end in
one shared clause banning every shadow variant and pinning centring *and* scale.
That clause is long because a single "no cast shadow" proved too easy to ignore:
the model likes sneaking a soft ground shadow under the object. Shadows and
glows are the app's job — each surface draws its own — never baked in.

The palette is the app's, and that is deliberate: a portrait is drawn to sit on
a GetHome device page, the way `rooms.icon` holds a token only the apps know how
to draw.

## Drawing (`src/portraits/openai-images.ts`)

OpenAI's Image API over plain `fetch`. **No SDK**: this is two endpoints and one
response field, and the hub ships its production `node_modules` to a Raspberry
Pi — the same reasoning that keeps the GitHub update check and the installer's
health poll on `fetch`.

**`gpt-image-2` is pinned.** `gpt-image-1.5` is deprecated; the newer model
supports `background: transparent` in preview, and a transparent cut-out is the
whole point: the apps float the object over their own glow and contact shadow,
so a boxed image would be a grey slab on the page. A model that rejected
`transparent` would fail with OpenAI's own message rather than quietly returning
a square.

Failures carry the vendor's own sentence and a `kind` from the shared
classifier in `src/ai/errors.ts` — which branches on HTTP status rather than on
anybody's error vocabulary, which is exactly why it is reusable here.

## Storing (`src/portraits/store.ts`)

```
<data>/portraits/<device id>/<portrait id>.png
```

Files, not rows. A 1024² transparent PNG is a megabyte or two, and putting that
in SQLite would push it through the WAL and every checkpoint — the write
amplification the whole store is arranged around. The row (`device_portraits`)
is the record of one, and the file is deleted with it. The directory sits inside
the systemd unit's `ReadWritePaths`, beside `update/` and matter.js's storage,
so no unit changed.

**No thumbnails are made here.** That would mean an image library — a native
dependency, cross-compiled, on a board with 415 MB of RAM — for something each
app already derives from the full PNG and caches locally.

### Bounds

Every other bound in this repository is about write *frequency*: a power meter
reporting for ever onto an SD card is what `STATE_FLUSH_MS` and the
five-minute history buckets exist to prevent. A portrait is not that — it is one
deliberate write per press of a button. What it needs is a bound on **bulk**,
and it gets the two this codebase always uses, plus a third that only a large
file needs:

| bound | value | why |
|---|---|---|
| per device | 6 | enough to browse and go back to one; not a photo album |
| per hub | 300 MB | about 150 portraits — an order of magnitude more than a home makes |
| free disk | refuse below 500 MB | the card holds the home's database, its Zigbee network key and its logs |

**A selected portrait is never evicted.** Dropping the picture a home is looking
at to make room for one it is not would be the worst possible trade; if the
budget is still over after sweeping the rest, the hub says so once rather than
deleting what is on screen. Drawing takes the selection, so the newest is always
the one in use and the oldest is what goes.

The free-space check is **inside** the serialisation queue, so two requests
cannot both pass it and then both write — and it runs *before* the request, not
after: OpenAI has already billed by the time the bytes arrive.

### Selection

`selected: null` while portraits exist is a **state, not an absence**: it means
somebody chose the procedural sphere over every picture they have. The apps have
always offered that, and expressing it as "no row selected" is what saves a
column that would otherwise mean the same thing twice.

## Serving

One generation at a time, hub-wide (`409 portrait_busy`) — a Zero 2 W holds two
of these in memory at once. The route is **synchronous**, holding the request
for the tens of seconds an image takes, which is what lets an app run one
uninterrupted animation from "reading your photo" to the finished portrait. If
the phone gives up, the hub finishes, stores and announces anyway: nothing is
lost but the animation.

`GET /portraits/:id` is the first route in this API that answers something other
than JSON. A portrait's bytes never change — a new one gets a new id — so it
carries a strong `ETag` and `Cache-Control: immutable`, and a phone downloads
each one exactly once. That matters more than it looks: these are megabytes
each, and the alternative is every device grid re-fetching the set over a home
Wi-Fi network on every launch.

Every change broadcasts `{"type":"portraits","deviceId"}` to **every** socket,
like `structure`, because the phone in the next room is looking at the same
device.

## Permissions

Drawing is `hub.ai` — the key that guards the credential it spends. Choosing
which portrait the home sees and deleting one are `device.edit`, because those
are ordinary shared edits about how the house looks, like a room's icon.
**Reading is the floor**: a portrait is what a device *looks like*, so a guest
whose dashboard could not draw it would be looking at a different home from
everybody else.

Only the drawing is written to the activity log (`device.portrait`), because it
spends money and everybody now sees a different picture. A restyle is not what
somebody reads the log for a week later — the same line `rooms.icon` holds.

## Tests

`test/portraits.test.ts` runs the whole thing end to end with the image call
mocked: the refusal with no key, drawing with and without a photo, the activity
row, the ETag and its 304, what each role may do, both bounds, and a removed
device taking its files with it.
