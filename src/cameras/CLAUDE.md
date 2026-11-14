# `src/cameras/` — cameras through the hub

Loaded when Claude works with files under `src/cameras/`. `docs/api.md`
(*Cameras*) is canonical for the routes and refusals and
`docs/mqtt-integrations.md` (*Cameras*) for the topic; `docs/security.md` names
the fetch in *What leaves the hub*. Update them in the same change.

- **`camera` is derived, never declared.** It is the last entry of
  `CAPABILITY_KINDS` and is deliberately missing from
  `DECLARABLE_CAPABILITY_KINDS`, which is what discovery documents, AI mapping
  descriptors and automation documents validate against. Each reason is a
  reader that has already shipped: a hub from before cameras refuses a
  discovery document naming a kind it doesn't know — the whole document — so a
  board that declared it would not be a device at all on most hubs it meets;
  and a stored mapping or rule naming `camera` could not be read by the build an
  update rolls back to. The MQTT adapter adds the kind on upsert from the
  retained `gethome/device/<id>/camera[/<endpoint>]` topic, so the same board
  is a camera here and a plain device on an older hub.
- **The address never leaves the adapter's memory.** `MqttAdapter` keeps the
  announced URLs in a map — the retained topic rebuilds it after a restart, so
  nothing is written to the card — and emits a hub-owned `camera` state patch
  with ids, kinds and sizes only. A `camera` key in a device's *own* state is
  stripped, or a device could forge the list the apps draw.
  `DeviceRegistry.cameraSource()` resolves a stream only on an endpoint that
  has the capability, and the routes name streams by device, endpoint and
  stream id.
- **An announcement is untrusted input that names a URL**, because every board
  in the house shares the integrations broker account — which makes this a
  request-forgery surface, and four rules close it. `policy.ts` accepts only
  plain `http:` to a **private IPv4 literal** (never a name: a lookup is
  somebody else's answer) with no userinfo; `proxy.ts` asks the same again
  where the request is made and adds the hub's **own addresses**, which can
  change after an announcement was checked; and nothing is relayed until the
  board **attests**: `GET /gethome/id` on the stream's port, then on 80, must
  answer the device's `externalId`. A port that doesn't answer moves on; **an
  id that is somebody else's ends it** (`camera_unverified`), and nothing
  answering anywhere is `camera_unreachable`. A proof is trusted for ten
  minutes per host and id.
- **`addressAllowed` is injectable so the suite can run a camera on
  loopback**, and one test proves the default refuses exactly that. Never widen
  the default to make a test pass.
- **`node:http`, not `fetch`.** `fetch` follows redirects and pools
  connections; here no redirect is followed (a 3xx is `camera_bad_response`),
  every request gets a fresh socket (`agent: false`), and the app's
  `Authorization` is never passed on. Only `image/jpeg` is relayed as a still
  (2 MB, 5 s) and only `multipart/x-mixed-replace` as a stream (1 MB a part,
  3 s to connect, 10 s of silence closes it).
- **One upstream per stream, because a small camera serves one client.** The
  first viewer opens it; later viewers attach to it; frames are re-framed under
  the hub's own boundary (`gethomeframe`) so nothing of the camera's headers
  reaches an app; a viewer more than `VIEWER_BACKLOG_BYTES` behind skips frames
  instead of holding the rest; the last viewer leaving closes it. At most
  `maxUpstreams` (4) at once — `camera_busy`, the one refusal that is a `409`
  (`cameraStatus`); everything else the camera did is a `502`. Nothing is
  written to disk.
- **`X-Content-Type-Options: nosniff` on the stream is load-bearing, and the
  framing is not what makes a picture late.** `URLSession` parses
  `multipart/x-mixed-replace` itself, and unless the response says `nosniff`
  it sniffs every part's type first: a part **under 512 bytes** is kept until
  bytes arrive after it, which on a live stream is the next frame. That reads
  exactly like a framing fault — each picture shown when the next one is
  written — and re-ordering what a frame's writes contain does nothing for it.
  Measured on macOS 27 with a `URLSessionDataDelegate` on 2026-11-14 (iOS not
  measured): through `CameraProxy` as it is, a picture written once a second
  or ten times a second, 70 bytes or 20 kB, reached the delegate 1–8 ms after
  the camera wrote it; the same bytes from a fake hub without the header
  arrived a whole frame late at 70–511 bytes and on time from 512 up. So a
  real camera's pictures are on time twice over, and the case that bites is a
  **test fixture**: a fake hub with a tiny JPEG and no `nosniff` shows a lag
  the hub does not have. Keep the header, keep each part written whole when
  its frame is (head with `Content-Length`, picture, `\r\n`), and before
  changing how a part is written read the stream with `URLSession` rather
  than `curl` or a browser, which do not hold anything back.
- **An API key may open one stream at a time, and never the last free one.**
  `camera.view` is key-grantable, and software holding a key tends to keep a
  stream for as long as it runs, while the four upstreams are shared with the
  people in the home — so `watch()` takes the key as its `opener`, the upstream
  remembers who opened it until it closes, and `refuseOpening` holds a key to
  `MAX_UPSTREAMS_PER_KEY` (1) and to `maxUpstreams - 1`, asked again after
  attestation, because other streams can open while a board is proving itself.
  **Joining an open upstream is never refused**, for anybody: it costs the
  camera and the hub nothing. Both refusals are `camera_busy` rather than new
  words, since an app already has a sentence for it and to whoever reads it
  the fix is the same. Stills are not counted — each is a fresh request, paced
  by the key's rate limit — and a person is held only to `maxUpstreams`, as
  before, though that is now asked after attestation too.
- **A live stream ends when the access behind it does.** It authorizes once,
  when it opens, so `server.ts` files each viewer in `cameraViewers` — a
  `MemberSessions` of its own, apart from the sockets' so neither spends the
  other's per-key limit — which is how revoking a key or removing a member
  hangs it up at once; and `watch()` takes an `allowed` check that `Upstream`
  asks before every frame, as the event socket asks a key before every frame,
  for a key that expires, is paused or loses `camera.view`, or a role that
  loses it. A viewer refused there is hung up, and nobody else is.
- **`describe()` is read by `GET /hub`**, which is the installer's health check
  and must never throw — keep it a constant. `maxStreamsPerKey` is the per-key
  limit above, and a hub without it lets no key watch a camera at all.
