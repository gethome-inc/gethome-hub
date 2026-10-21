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
- **`describe()` is read by `GET /hub`**, which is the installer's health check
  and must never throw — keep it a constant.
