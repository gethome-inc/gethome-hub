# Hub API

Base URL: `http://<hub>:8420/api/v1`. JSON everywhere. Discover hubs via mDNS
(`_gethome._tcp`, TXT: `id`, `ver`, `api`, `claimed`) or connect by address.

## Authentication

`GET /hub` is public (discovery/health). Everything else requires
`Authorization: Bearer <token>` (or `?token=` for the WebSocket).

### Claiming

Tokens come from the claim flow, and **a token never expires** — a device
connects once and is never asked again. That is the point of the whole design:
the code is a one-time proof of physical access, not a password.

1. An unclaimed hub writes an 8-digit **pairing code** to `<data>/pairing-code`
   (0600) and logs it, and **keeps it** until somebody claims the hub. It used
   to be re-minted on every boot, which meant any code that had been read — the
   `@@PAIRING@@` marker from the install, or a value fetched a minute ago — was
   a different number by the time it was used. On a small board where the hub
   restarts (an update, a power cut, the OOM killer) that turned a finished
   install into `invalid_code` with nothing the user could do. Rotation bought
   nothing either: the code only ever proves access to the machine, and reading
   the file *is* that access. Moving the file, or the `Pairing code: <digits>`
   log line, breaks GetHome Studio's fallback path.
2. `POST /pair {"code","memberName","deviceName"?,"claimId"?}` — the first
   successful claim creates the **owner** and returns `{token, member}`. The
   code dies with the claim. `claimId` is the client's own UUID for *this
   attempt*, kept across retries: a hub can commit a claim and lose the
   response on the way back, and without an id the retry finds a code that is
   already spent and is told it is wrong. With one, the hub replays the
   original answer for five minutes. Failed attempts are rate-limited per
   address.
3. Owners mint **invite codes** (`POST /invites`, 15-minute TTL, single use);
   claiming one through the same `/pair` endpoint creates a **member**. This is
   how a phone or a second Mac joins.
4. `POST /invites {"memberId"}` mints a **sign-in code** instead — the same
   eight digits, TTL, single use and `/pair` route, for somebody who is
   *already* in the home. Claiming it creates nobody and issues another token
   for that member, so a second phone, or the same phone after the app was
   deleted and installed again, comes back as **the same person**. See
   [below](#signing-in-again-post-invites-with-a-memberid).

**On the hub's own machine there is a shorter route.** `gethome-hubctl claim
--name "…" --device "…"` reads the code and claims in one step, printing
`@@HUBID:…@@` and `@@TOKEN:…@@`. Anyone who can run that already holds root on
the machine the code exists to prove access to, so requiring them to recite the
number adds a step that can only fail. GetHome Studio uses it over SSH, which
is why the person who installs a hub is never shown a code at all.

### Roles and permissions

A **permission** is a verb this hub understands. A **role** is a named set of
them. A **member** holds exactly one role. Three roles ship built in — **Owner**,
**Member**, **Guest** — and a home can add its own; what each one may do is a
table the home edits, from either app. See
[Roles and permissions in full](#roles-and-permissions-in-full).

This replaced a single comparison — `member.role !== 'owner'` — which guarded
fifteen routes and left everything else open to anybody. The only knob was which
side of the owner line a whole route sat on, and moving it moved it for
everyone.

**Three things a client should know before reading the table below.**

- **The floor is not a permission.** Reading the home (`GET /hub`, `/home`,
  `/rooms`, `/zones`, `/devices`, `/members`, `/roles`, `/permissions`, `/me`,
  the WebSocket), **working a device**, renaming yourself, leaving, pinning
  your own favorites and putting yourself on another of your own devices
  ([a sign-in code for yourself](#signing-in-again-post-invites-with-a-memberid))
  are what *being a member* means. No role can take them
  away, and none of them appears in the matrix. A member with nothing at all
  would be a token that can only 401 behind an app with nothing to draw.

  Switching things on was a `device.control` key for a day, and retiring it is
  the clearest case the floor has. An app whose whole job is working the home
  cannot have a member who may not work the home — that is not a restricted
  member, it is a member with no reason to open the app. And a permission every
  role must hold is a row in the matrix that can only ever be wrong: somebody
  would turn it off, and find out. So the key is gone rather than shipped
  switched on for everybody, and `POST /devices/:id/endpoints/:id/commands`
  takes any token.
- **The owner is never evaluated.** Every check answers `true` for the owner
  without reading a stored set, so a permission a later hub build adds is theirs
  automatically and no edit to any table can lock a home out of itself. That
  backstop is why `role.manage` can be handed to anybody with no escalation
  guard behind it.
- **The defaults reproduce exactly what this hub did before roles existed.**
  `Member` is, key for key, the routes that were open to any member; the keys
  missing from it are the ones that were owner-only. Updating a hub changes
  nothing at all until somebody edits the matrix.

**Ask `GET /me` rather than inferring anything from a role name.** A home that
has edited its own matrix, or invented a role, is one where "member" says
nothing about what this caller may do — and a button that can only 403 is worse
than no button.

## REST routes

| Method & path | Needs | Notes |
|---|---|---|
| `GET /hub` | — | `{hubId, name, version, build?, apiVersion, claimed, zigbee: {enabled, connected}, radio: {budget, mode, matter, canRunBoth}}`. `name` is the home's name — see [below](#the-hubs-name-is-the-homes-name). `build` is CI's stamp (`<version>-<sha>-<branch>`) and names the release directory on the machine — `version` alone reads the same before and after an update, so it can't answer "did my update land?". Absent on a hub built from source. `zigbee.connected` is Zigbee2MQTT's bridge reporting itself online, not merely that the broker is up, so an app can say "plug a coordinator in" instead of showing an empty section; `zigbee.problem` is [below](#why-zigbee-is-down-zigbeeproblem); `zigbee.permitJoin: {active, remainingSeconds}` is the live join window and is [below](#the-zigbee-join-window). `radio` is [further below](#radio-get-hub-and-put-settingsradio). `history: {bucketSeconds, retentionDays}` (300 and 7 today) is present only on a hub that records readings — its *absence* is how an older hub says it doesn't, see [below](#recorded-readings-get-devicesidhistory). `portraits: {model, maxPerDevice, budgetBytes}` is the same shape of answer for device portraits: present means this hub can draw them, and whether a *key* has been saved is a different question `GET /settings/ai` answers — see [below](#device-portraits). `matter: {bluetooth, bluetoothReason?, wifi, commissioning, settlingUntil?}` is present only while Matter is running and says what pairing this hub can actually do — and, in `settlingUntil`, whether it has finished finding the devices it already owns — see [below](#pairing-a-matter-accessory). `pairing: {signInCodes: true}` is presence-means-capability once more, and the one where reading it matters most: an app that does not find it **must not** ask for a sign-in code, because an older hub strips the unknown field and answers with an ordinary invite — see [below](#signing-in-again-post-invites-with-a-memberid) |
| `POST /pair` | — | claim / join, returns `{token, member}`; 401 on bad code, 429 after repeated failures; reuse `claimId` when retrying |
| `GET /home` · `PATCH /home` | floor · `home.rename` | `{id, name}`. `PATCH {name}` (trimmed, 1–80 chars) renames the hub *and* the home — they are one name, see [below](#the-hubs-name-is-the-homes-name) |
| `GET /rooms` · `POST /rooms` · `PATCH /rooms/:id` · `DELETE /rooms/:id` | floor · `home.structure` | `{id, name, zoneId, icon, accent, sortOrder}`. `POST` takes `{name, zoneId?, icon?, accent?, sortOrder?}` — the name is the only required field anywhere here — and `PATCH` takes the same set with every field optional; `zoneId: null` means "in no zone", and `icon: null` / `accent: null` mean "back to the look the app derives" — each different from leaving the field out. `icon`/`accent` are opaque app tokens (1–40 chars, see [below](#rooms-and-zones)). Names are trimmed before they are measured (1–80), an unknown `zoneId` is `404 unknown_zone`, and a new room goes to the *end* of the order. Deleting a room does not delete its devices — they are simply in no room. Every write broadcasts the [`structure` frame](#rooms-and-zones) |
| `GET /zones` · `POST /zones` · `PATCH /zones/:id` · `DELETE /zones/:id` | floor · `home.structure` | `{id, name, sortOrder}` — the optional layer above rooms, see [below](#rooms-and-zones). `POST {name, sortOrder?}`, `PATCH {name?, sortOrder?}`; a zone carries no look of its own, since nothing draws a zone as a thing. Deleting a zone keeps its rooms and leaves them in none |
| `GET /devices` | floor | full device list (wire shape below) |
| `PATCH /devices/:id` | `device.edit` / floor | `{name?, roomId?, favorite?, offlineExpected?}`. Name, room and `offlineExpected` describe the house and everybody sees the same ones; **`favorite` is the caller's own** and nobody else's — see [below](#favorites-are-per-member). `roomId: null` takes a device out of its room; an unknown one is `404 unknown_room`. `offlineExpected` is a boolean in and a moment back out — see [below](#a-device-that-is-meant-to-be-offline). The response is this caller's view of the device |
| `DELETE /devices/:id` | `device.remove` | also unpairs at the protocol level |
| `POST /devices/:id/endpoints/:endpointId/commands` | floor | body = canonical command; `202`. IR-remote intents (`irLearn`/`irSaveLearned`/`irSend`/`irDeleteCommand`/`irRenameCommand`) are resolved against the endpoint's stored code library (see [device-schema.md](device-schema.md)) |
| `GET /devices/:id/history?from=&to=&points=&series=` | floor | what this device's readings did over a window, already thinned to a drawable size — see [below](#recorded-readings-get-devicesidhistory). `from`/`to` are epoch ms and default to the last day; `from >= to` is `400 invalid_range`; an unknown device is `404` |
| `GET /devices/:id/portraits` | floor | the pictures this home has had drawn of a device, newest first: `{id, at, bytes, provider, model, fromPhoto, selected, drawnBy?}`. `drawnBy: {id, name}` is who had it drawn — `id` is null once that person has left the home and absent altogether on a portrait drawn before the hub recorded it, so an app draws no line rather than an empty one. Reading is the floor — a portrait is what the device *looks like*, so a guest whose dashboard could not draw it would be looking at a different home. See [below](#device-portraits) |
| `GET /portraits/:portraitId` | floor | the PNG itself — `image/png`, a strong `ETag` and `Cache-Control: immutable`, because a portrait's bytes never change (a new one gets a new id) |
| `POST /devices/:id/portraits` | `hub.ai` | draw one. `{photo?: base64, photoType?}` — absent draws from the device's kind alone. Synchronous, and it holds the request for the minutes an image takes. `409 openai_not_configured` (its own code: portraits are OpenAI's job, and a hub can be configured for recognition and not for this), `409 portrait_busy`, `409 no_space`, `502 {error:"provider_failed", kind, detail}` carrying OpenAI's own sentence |
| `PATCH /devices/:id/portraits` | `device.edit` | `{selected: id\|null}` — which one the home sees. `null` is a *state*: the procedural sphere, chosen over every picture there is |
| `DELETE /portraits/:portraitId` | `device.edit` | forget one, file and row |
| `POST /devices/:id/remap` | `hub.ai` | force-regenerate the AI mapping (Zigbee devices) → `{requested}`. **It answers as soon as the run is under way, never when it ends**: a run is minutes and this is an HTTP request, so what the agent then did arrives on the `ai` stream and in `GET /ai/runs`. `requested: false` means the radio has no published schema for that device right now — a device row can outlive its `bridge/devices` entry — which is a different answer from a run that failed. Being explicit, it also drops a `rejected` mapping and **ignores the backoff gate**, because it is how somebody retries after fixing a key or changing the model. The hub also remaps automatically when a device publishes unknown parameters — see [ai-adaptation.md](ai-adaptation.md). `409 ai_not_configured` with no credential, `409 ai_disabled` when the owner has switched adaptation off |
| `POST /matter/commission` | `device.add` | `{pairingCode, wifi?: {ssid, passphrase}}` → `202 {jobId, deadline}` (async). `wifi` is only for a hub that cannot read its own — see [below](#pairing-a-matter-accessory). `409 already_commissioning` when one is already running, `409 matter_disabled` when this hub has no Matter |
| `GET /matter/commission/:jobId` | floor | `{status: running\|done\|failed, step?, nodeId?, error?, failure?, startedAt, deadline}` — see [below](#pairing-a-matter-accessory) |
| `POST /matter/commission/:jobId/cancel` | `device.add` | stop looking → the job as it now stands. `404` for a job the hub has forgotten; a job that has already finished is answered, not refused |
| `GET /matter/discoverable?seconds=` | `device.add` | what the hub can hear **right now** → `{scannedMs, bluetooth, devices: [{discriminator, vendorId?, productId?, name?, transport, pairingHint?, pairingInstruction?}]}`. `seconds` is 2–15, default 6, and the request is held open for all of it. `409 already_commissioning` — see [below](#what-the-hub-can-hear-get-matterdiscoverable) |
| `POST /zigbee/permit-join` | `device.add` | `{seconds}`, 0–900 (0 = close the network) → `{permitJoin, seconds}` describing the **live** window, which is not always what was asked for. See [below](#the-zigbee-join-window) |
| `GET /members` · `PATCH /members/me` · `DELETE /members/me` · `DELETE /members/:id` | floor · floor (itself) · floor (itself) · `member.remove` | rows carry `isSelf`, `roleId` and `roleName`; `PATCH` takes `{name}` and renames **the caller**; `DELETE` on either route answers `204` and revokes that member's tokens; the owner cannot be removed, by anyone or by itself. See [below](#which-member-you-are-isself-and-patch-membersme) |
| `GET /invites` · `POST /invites` | `member.invite` · see notes | `POST {roleId?}` → `201 {code, expiresAt, roleId, roleName, memberId: null, memberName: null}`. Omitting `roleId` mints a **Member** invite, which is what every invite this hub has ever made was. An **owner** invite is allowed and needs the caller to be one (`403 not_owner`). **`POST {memberId}` mints a sign-in code** for somebody already here — `roleId` beside it is `400 invalid_target`, an unknown one is `404 unknown_member`, and the answer carries `memberId`/`memberName` with `roleId: null`. Who may ask is asked of the body: your own (`memberId: "me"` is accepted) is the **floor**, somebody else's is `member.invite`, an **owner's** needs an owner. `GET` lists the live codes, each with `memberId` — null for an invite — and `memberName`. See [below](#signing-in-again-post-invites-with-a-memberid) |
| `GET /activity?limit=&before=` | floor · `activity.read` | reverse-chronological, cursor = `before` id; rows carry `data` — see [below](#the-activity-log) |
| `GET /settings/ai` · `PUT /settings/ai` · `PATCH /settings/ai` · `DELETE /settings/ai` | `hub.ai` | The home's AI: two credentials, two models, which provider recognises devices, and the switch. **PATCH is the write** — every field optional, absence means "leave this alone": `{enabled?, recordExchanges?, anthropicApiKey?, openaiApiKey?, anthropicModel?, openaiModel?, model?, mappingProvider?, clear?}`. `model` is `anthropicModel` under the name this route has always used; `clear: "anthropic"\|"openai"` forgets one credential and leaves the other; `recordExchanges` starts or stops keeping what each round said, and is off unless asked; `mappingProvider` naming a provider with no key is `400 provider_not_configured`. Keys are told apart by prefix, so one pasted in the other's field is a 400 rather than a 401 an hour later, and a `sk-ant-oat…` subscription token is still refused. **PUT is unchanged** (`{apiKey, model?}`, an Anthropic key, required) for apps that have not moved. See [the answer's shape](#the-ai-settings-answer) |
| `GET /ai/runs?limit=` | `hub.ai` | what the mapping agent did, newest first: `{id, at, kind, vendor, model, exposesHash, provider, modelId, ok, costUsd, turns, durationMs, errorKind, errorMessage, steps, exchanges}`. A summary, never a transcript — see [ai-adaptation.md](ai-adaptation.md). `exchanges` is how many **rounds** this run kept, `0` unless recording was on when it ran |
| `GET /ai/runs/:id/exchanges` | `hub.ai` | what that run actually said, round by round, oldest first: `[{seq, at, durationMs, provider, modelId, status, ok, inputTokens, outputTokens, sent, received}]`. `sent`/`received` are `[{kind, label, text?, bytes?}]` — the round's **main data**, not its bodies; `bytes` is present only on a part that was cut, and is what it weighed whole. A run is a *loop*, so one recognition is several rounds and a failed one is followed by the next in the same list. Empty is the ordinary answer — recording is off unless the owner asked, and rounds age out after a week. See [ai-adaptation.md](ai-adaptation.md) |
| `GET /automations` | floor | every rule in the home, plus `unreadable` — rules a **newer** build wrote that this one cannot parse. They are kept and not run; listing them is what stops a rule silently vanishing after `install.sh` rolls a build back. Each carries `summary` (a whole sentence — the contract) beside `document` (the structure — the convenience), the `activity.message` rule applied to rules, [`outline`](automations.md#a-rule-as-a-storyboard) — the same rule as a **storyboard** so an app can *draw* it rather than print it — `icon` — the mark somebody chose, or `null` for the one the app derives — and `roomId`, [the one room the rule is about](#which-room-a-rule-is-in) or `null` for a rule about the whole house |
| `GET /automations/:id` · `GET /automations/:id/runs` | floor | one rule, and why it fired. The trace names the commands a guard **refused** as well as the ones it sent: "nothing happened" and "the hub declined to switch that relay for the fortieth time this hour" look identical from outside |
| `GET /automations/capabilities` | floor | what a rule can be made of, **generated from the live zod schema**. Render this rather than shipping a copy — the `GET /permissions` rule applied to a vocabulary that will keep growing |
| `GET /automations/templates` | floor | the shipped presets, with the inputs each needs |
| `POST /automations/:id/run` | floor | press a button automation → `202`. **The floor, deliberately**: pressing "I'm leaving" switches lights, and working the home is what being a member means. `409 automation_disabled`, `409 not_pressable` for a rule that watches the home and has nothing to press |
| `PUT /automations/:id/active` | floor | `{active}` — switch a *mode* on or off. Also the floor, and a different thing from `enabled` below: turning a mode on is working the home, enabling a rule is editing it. `409 not_a_toggle` |
| `POST /automations` | `automation.manage` | the document as the body → `201`, **always switched off**, with `warnings`. `422 {error:"invalid_automation", issues}` for a shape the schema refuses, `422 {…, problems, warnings}` for one it accepts and the home cannot use — a threshold on a continuously-varying reading with no `for` or `hysteresis` is the commonest |
| `PATCH /automations/:id` | `automation.manage` | `{document?, enabled?, name?, icon?}`. Switching it back on clears whatever the circuit breaker wrote. **`name` and `icon` are what a rule is called and how it is drawn**, and they are here rather than only inside `document` because a rename is a different act from an edit: the apps hold the `summary`, so asking a phone to send a whole rule back to fix a typo would mean every app carrying a second copy of the DSL. A rename is written into `document.name` as well as the column — they are one fact stored twice, and an edit made in conversation afterwards would otherwise put the old name back. It costs no version (ten are kept per rule to walk back out of a bad afternoon, and the behaviour is untouched) and it *is* written to the activity log, where a restyle is not — the rooms rule. `icon` is an opaque app token, `null` for "the app derives one" |
| `DELETE /automations/:id` | `automation.manage` | forget it, and its versions and traces with it |
| `GET /automations/:id/versions` · `POST /automations/:id/revert` | `automation.manage` | what it used to say, and going back to it. `{versionId}` |
| `POST /automations/dry-run` | `automation.manage` | check a document without saving: `{problems, warnings, shape, summary, outline}` — the same pair every rule carries, so a preview draws exactly what the saved rule would |
| `POST /automations/templates/:key` | `automation.manage` | install a preset. A template may install **more than one** rule — "light on movement" is genuinely two — so this answers with a list |
| `POST /automations/chat` | `automation.manage` **+** `hub.ai` | start a conversation: `{message, automationId?}` → `201 {sessionId, messages}`. **An acknowledgement, not an outcome**: `messages` is the person's own row and nothing else, and it answers the moment the hub takes the message — a turn is a provider loop with a three-minute watchdog and no client waits that long. What the agent says arrives on the opt-in `automations` stream, and its `turn` frame is what says the transcript is ready to re-read. Three refusals, all `409 {error, detail}` because they lead to three different screens: `ai_not_configured` (no key), `ai_disabled` (the owner switched AI off), `automation_needs_anthropic` (a key, but only OpenAI's — the OpenAI half of this agent is not written). `detail` is a sentence, so an app that has never met one of these codes still shows something true. The route names `automation.manage` in a refusal; the second key is checked in the handler and refused in the same `{error, permission}` shape |
| `POST /automations/chat/:id/messages` | `automation.manage` **+** `hub.ai` | `{message}` → the same acknowledgement shape, and the same rule: it returns when the message is taken, never when the turn ends. Turns are chained per conversation, so a second message sent while one is running is queued rather than run beside it. A typed reply to a question is treated as the *answer* to it, since only the conversation knows whether a tool call is outstanding. **`410 conversation_ended`** only when there is nothing left to read — a session that never existed, or one past the fortnight transcripts are kept for. A hub that has merely *forgotten how to continue* (a restart, or the two-hour idle sweep) rebuilds the model's memory from the stored transcript and carries on under the same session id, because that state is the ordinary one and refusing it made the whole conversations list read-only |
| `GET /automations/chats` | `automation.manage` **+** `hub.ai` | every conversation this home has had, newest first: `[{sessionId, startedAt, updatedAt, messageCount, title, live, spend?}]`. `title` is the **first thing the person said** — the agent's opening line is about the home rather than about what was asked — and `live` is whether it can still be *continued*, which is a different question from whether it can be read. `spend` is `{usd, provider, modelId, model}`: what it cost and what answered, with `model` the label to draw and `modelId` the id as recorded. It is **absent rather than zero** when the hub cannot say — `ai_runs` keeps sixty runs and a transcript a fortnight, so a readable conversation can outlive its own spend row, and `$0.00` about one that plainly cost something is a claim |
| `GET /automations/chat/:id` | `automation.manage` **+** `hub.ai` | `{sessionId, live, spend?, messages}` — the transcript, oldest first, with the same `spend` block the list carries so a chat opened from a link says what it cost without the list having been read. `live: false` is history. A message is `{id, at, role, text, data?}` with `role` an **open** vocabulary (`user`/`agent`/`question`/`preview`/`note`); see [`docs/automations.md`](automations.md) for what `data` carries per row. **One turn can write several `preview` rows** — a reply that delivers two rules is one `agent` line followed by a card each, in submission order, so draw a card per row rather than assuming one per turn. The **first** row a round writes also carries `data.steps` — `[{text, kind, detail?}]`, what the agent did to produce it, the same three fields the `step` frame streams — so a conversation read back next week shows the working and not only the answer |
| `DELETE /automations/chat/:id` | `automation.manage` **+** `hub.ai` | end it and write down what it spent |
| `POST /assistant/chat` | `hub.ai` | start a conversation with the **assistant** — the agent behind the app's assistant button: `{message}` → `201 {sessionId, messages}`. Same acknowledgement shape and same rule as the automations chat above, and the same three `409` refusals. Guarded by `hub.ai` **alone**: asking what the kitchen is doing and switching a lamp on is the floor, and the key is asked because a conversation spends the home's money. Handing a job to another agent is where `automation.manage` is asked, and it is asked *inside the tool* — so a member whose role cannot do it gets a sentence the model reads out rather than a route that 403s |
| `POST /assistant/chat/:id/messages` | `hub.ai` | `{message}` → the same acknowledgement. `410 conversation_ended` only when there is nothing left to read |
| `GET /assistant/chats` | `hub.ai` | the assistant's own conversations, newest first, in the same shape `GET /automations/chats` answers. The two lists are **disjoint**: rows carry a `surface`, and a row written before that column existed is an automations row |
| `GET /assistant/chat/:id` | `hub.ai` | `{sessionId, live, spend?, messages}`, the same shape as an automations transcript with one more `role`: **`handoff`**, a job handed to another agent. Its `data` is `{agent, title, brief, sessionId, status, automationIds}` — `sessionId` is the *other* agent's conversation, which is where the live trail, its questions and the rules it wrote are read from; `status` is `working`/`asked`/`delivered`/`failed` and is an **open** string; `automationIds` fills as that agent saves rules. Nothing about the other conversation is copied into this one |
| `DELETE /assistant/chat/:id` | `hub.ai` | end it and write down what it spent |
| `GET /settings/timezone` · `PUT /settings/timezone` | floor · `automation.manage` | what "at ten in the evening" means. The system's zone seeds it and the database owns it; `400 unknown_timezone` for one `Intl` cannot use, refused here rather than taking every schedule down on every tick |
| `GET /device-mappings` | `hub.ai` | the mapping library: one entry per device model, `{adapter, exposesHash, vendor, model, status, source, problems, endpoints, deviceIds, createdAt, updatedAt}` |
| `GET /device-mappings/:exposesHash` | `hub.ai` | the download — an envelope naming the device, see [below](#the-device-mapping-library) |
| `PUT /device-mappings/:exposesHash` | `hub.ai` | the upload. Accepts the envelope or a bare descriptor. `422 {error:"invalid_mapping", problems, issues?}` when the hub can't use it — and it is **kept**, so `…/repair` can work from it |
| `DELETE /device-mappings/:exposesHash` | `hub.ai` | forget it; devices of that model fall back to their static mapping, and **nothing is asked of the agent** — a delete that re-consulted the library would miss the row it had just removed and start a fresh paid run inside the request, so Forget cost a replacement for the mapping being forgotten. The next genuine trigger asks |
| `POST /device-mappings/:exposesHash/repair` | `hub.ai` | hand a rejected descriptor to the agent with the complaints. `409 ai_not_configured` / `409 ai_disabled` / `409 nothing_to_repair`, `422 no_device` |
| `PUT /settings/radio` | `hub.radio` | `{mode: "auto"\|"zigbee"\|"matter"\|"both"}` → `{budget, mode, matter, canRunBoth, modes, applying: true}`. Records a *request*; see below. It also hands back the hub's two automatic retries when `mode` is `"both"`. `both` is accepted on **any** board — `budget` is advice, not a ceiling — and is refused with 400 by a hub too old for it, which is why `radio.modes` exists |
| `GET /settings/mqtt` | `hub.mqtt` | the broker's credentials: `{requiresPassword, host, port, baseTopic, accounts[]}`. Each account is `{id, username, password, recommended, title, summary, publish[], subscribe[]}`. `hub.mqtt.admin` **adds** the hub's own full-access account; without it only the limited one is returned. See [below](#the-mqtt-broker-asks-for-a-password) |
| `GET /me` | floor | `{id, name, role: {id, key, name}, permissions, isOwner}` — who this token belongs to and what it may do. See [below](#roles-and-permissions-in-full) |
| `GET /permissions` | floor | the catalog: `{key, group, title, summary}` per permission. The hub owns the wording |
| `GET /roles` | floor | `[{id, key, name, builtin, permissions, memberCount, sortOrder}]` |
| `POST /roles` · `PATCH /roles/:id` · `DELETE /roles/:id` | `role.manage` | `POST {name, permissions?}` → 201. `PATCH {name?, permissions?}`. `409 role_is_owner`, `409 role_is_builtin`, `409 role_in_use` |
| `PATCH /members/:id` | `role.manage` | `{roleId}` — put somebody in a different role, the owner's included. Granting or revoking that one needs the caller to be an owner (`403 not_owner`); the last owner cannot be moved out of it (`409 cannot_change_owner`). `404 unknown_role` |
| `GET /system/update` | floor | what is installed, whether anything newer exists, and how a run is going — see [below](#updating-the-hub). `?refresh=1` asks GitHub again, behind a one-minute floor. **Reading is the floor on purpose**: somebody who may not press the button still has to see why the home went quiet for two minutes |
| `POST /system/update` | `hub.update` | ask the hub to update itself → `202 {id, state:"queued"}`. `409 update_unsupported` on a machine with no update plumbing, `409 update_in_progress` while one is running |
| `GET /system/update/log?tail=` | floor | the tail of what the installer printed: `{lines, total, truncated}`. Default 200 lines, max 2000 |

### Roles and permissions in full

#### The fifteen permissions

`GET /permissions` is the authority and carries a `title` and a `summary` for
each. **Render those rather than shipping copy of your own** — it is the
`activity.message` rule applied to a vocabulary that will grow, so an app a
version behind still draws a complete, truthful matrix instead of a row labelled
with a key nobody can read. What an app *does* hard-code is the handful of keys
it gates its own screens on.

| key | group |
|---|---|
| `device.edit` | Devices |
| `device.add` | Devices |
| `device.remove` | Devices |
| `home.structure` | Home |
| `home.rename` | Home |
| `activity.read` | Home |
| `automation.manage` | Home |
| `member.invite` | People |
| `member.remove` | People |
| `role.manage` | People |
| `hub.radio` | Hub |
| `hub.update` | Hub |
| `hub.ai` | Hub |
| `hub.mqtt` | Hub |
| `hub.mqtt.admin` | Hub |

#### What the three built-in roles start with

|  | Owner | Member | Guest |
|---|:--:|:--:|:--:|
| `device.edit` | ✓ | ✓ | |
| `device.add` | ✓ | ✓ | |
| `home.structure` | ✓ | ✓ | |
| `activity.read` | ✓ | ✓ | |
| `automation.manage` | ✓ | ✓ | |
| `hub.radio` | ✓ | ✓ | |
| `hub.update` | ✓ | ✓ | |
| `hub.ai` | ✓ | ✓ | |
| `home.rename` · `device.remove` · `member.invite` · `member.remove` · `role.manage` | ✓ | | |
| `hub.mqtt` · `hub.mqtt.admin` | ✓ | | |

**Member is the old behaviour written down, with two deliberate exceptions.**
Those keys are, key for key, the routes that used to be open to any member; the
five on the row below them are the ones that used to be owner-only. A hub that
updates into this changes nothing about what anybody can do — the migration
backfills every existing member into Owner or Member accordingly, and only an
explicit edit moves anything after that.

`hub.update` is the one that looks like an exception and is not.
`POST /system/update` was owner-only for about a day, and what settled it was
who the owner *is*: Studio claims a hub as *the Mac*, so the owner is a laptop
in a drawer and every phone joins by invite (Owner is handed over by an owner,
which nobody had done) —
owner-only did not mean "an update needs care", it meant the phone in somebody's
hand could never update their own home. It was open to every member by the time
roles landed, so Member holding it takes nothing from anybody, and Guest is a
role that did not exist. Being a key rather than either extreme is what lets a
home that *does* want it kept from the spare room say so.

`hub.ai` is the second exception, and it moved on the same argument. It guards
the AI keys, the adaptation switch, the mapping library and *drawing a device
portrait* — all of which spend the home's money, which is a real reason for care
and not a reason for owner-only: the person standing in front of the kettle is
the one who wants a picture of it, and on a hub Studio claimed as the Mac that
person is never the owner. Guest is where the line falls. Unlike `hub.update`
this is a genuine change to what a member may do, so it travels with a migration
that grants it to hubs that already exist — `ensureBuiltins()` inserts with
`ON CONFLICT DO NOTHING` and would never reach a `member` row that is already
there.

**The two MQTT keys are neither exception, and they are the one place the
"bounded cost" test comes out the other way.** They are newer than the rest of
this table — the broker took anonymous connections when it was written — and
they are owner-only because **a broker password is a secret that leaves the
building.** Every other permission is a request the hub carries out and can stop
carrying out, so removing a member ends it within the second; nothing can
un-tell somebody a password, and taking one back means minting another and
revisiting every board in the house that had it. That is a front-door key rather
than a spending decision, which is why the argument that moved `hub.update` and
`hub.ai` does not reach it. A home that wants it otherwise grants `hub.mqtt` in
the matrix — the safe half, since the account it reveals cannot switch anything
on — and leaves `hub.mqtt.admin` where it is.

**Guest is somebody staying in the house** — and a role with **no keys at all**,
which is its honest shape rather than an oversight. They work the lights and keep
their own favorites because both are the *floor*; what they do not get is
everything above that line — they change no names, open no network, and read only
their own line in the activity log.

#### The owner is a special case on purpose

The owner's stored permission list is **for display only and is never read**.
Every check answers `true` for the owner without consulting it, which buys three
things worth keeping:

- a permission a later hub build adds is the owner's automatically, with no
  migration and nothing to forget;
- no edit to any table can lock a home out of itself, so editing the matrix is
  never the thing that takes a home away from the people in it;
- and one refusal follows: `PATCH /roles/:id` and `DELETE /roles/:id` answer
  `409 role_is_owner`, because nothing reads that row — a control that moved a
  number on a screen and nothing in the world would be worse than no control.

#### Owner is a role somebody holds, and a home always keeps one

The role itself is **ordinary**: it can be invited into (`POST /invites` with
its `roleId`), assigned (`PATCH /members/:id`) and taken away again. Several
people can hold it at once, and each of them is answered `true` without a stored
set being read.

Two rules replace what used to be a flat refusal on all of it.

**Only an owner may grant the owner's role, or take it back.** `role.manage` is
what edits the matrix and a home can hand it to a role it invented — so if that
permission alone could promote, it would quietly come to mean "can make myself
owner" and every other permission would be a formality. That check is what keeps
`role.manage` safe to delegate. Refused with **`403 not_owner`**, deliberately
*not* `owner_only`: both GetHome apps read that word as "this hub predates roles,
update it", and would send somebody to fix a hub that is working perfectly.

**A home always keeps at least one owner.** Moving the last one out of the role
is `409 cannot_change_owner`; removing them, or their leaving, is
`409 cannot_remove_owner`. Both codes are the ones that already existed, narrowed
to the case that still matters — an app a version behind then shows its old
sentence, which is still roughly true, rather than nothing at all. The reason is
narrower than it used to be and is the whole of it: granting the role is
owner-only, so a home with no owner has nobody left who could give it one.

#### Roles a home invents

`POST /roles` mints one with a key of its own. Built-in roles cannot be deleted
(`409 role_is_builtin`) and **no role can be deleted while somebody holds it**
(`409 role_in_use`): `members.role_id` carries no `ON DELETE` action — SQLite
cannot attach one to a column added by `ALTER TABLE` — so that refusal *is* the
referential integrity, and quietly moving somebody to another role as a side
effect of a delete is not a behaviour worth having. Move them first, then
delete.

**An outstanding invite is not somebody holding it, and it goes with the role.**
`invites.role_id` is the same kind of column with the same missing action, so a
code minted into a role that is then deleted has to be dealt with here. The two
alternatives are both worse: clearing the column would let that code admit its
holder as a plain **Member** — an escalation nobody asked for, and the exact
silent reassignment the paragraph above refuses — while refusing the delete
would be a dead end, since no route revokes an invite, so the home would be told
`role_in_use` about a role nobody wears and could only wait out the expiry. An
invite's whole content is "join as this"; with the role gone it means nothing,
it lives fifteen minutes, and minting another is one tap. A client should
re-read `GET /invites` after deleting a role.

#### Learning what you may do

Three ways in, and they answer the same question:

- `GET /me` — `{id, name, role: {id, key, name}, permissions, isOwner}`.
- The WebSocket `hello` frame carries `permissions`, so a client knows in its
  first frame and never paints a control it is about to lose.
- The `access` frame — [below](#what-you-may-do-access) — arrives behind `hello`
  and again whenever it changes.

`POST /pair` and `PATCH /members/me` both answer with the member shape plus
`permissions`, so a client that has just joined needs no second request.

**A client that sees no `permissions` field is talking to a hub older than this,
and must fall back to the old rules — never to "nothing allowed".** Absence is
not a refusal, the same rule `radio.budget`, `zigbee.problem`, `isSelf` and
`recognition` all follow.

### The hub's name is the home's name

One hub hosts exactly one home and a home cannot move between hubs, so there is
**one name**, stored once, and `GET /hub`, `GET /home` and the WebSocket
`hello` frame all answer the same string.

There used to be two. `GET /hub` answered `HUB_NAME` from
`/etc/gethome/hub.env` — written once by the installer and never edited by
anyone — while `GET /home` answered a database row the apps could rename. So a
hub whose owner had called it "Summer House" in the app still advertised
itself as "GetHome Hub" over mDNS, still said "GetHome Hub" in GetHome Studio,
and two hubs on one Mac were two rows with the same name. The second name was
never a second fact, only a second place for the first one to be wrong.

- **`HUB_NAME` seeds; the database owns.** The environment variable names a hub
  that has no name yet — a first boot. After that it is inert: editing
  `hub.env` and restarting changes nothing, and `PATCH /home` is the only way
  to rename a hub.
- **A rename needs no restart and no root.** It reaches `GET /hub` (public, so
  an app that has not been claimed still sees it), the WebSocket hello, and the
  mDNS advertisement — which is re-published under the new name, by rewriting
  avahi's service file or by re-creating the `ciao` service.
- **The name is public.** `GET /hub` is unauthenticated and the name is the
  mDNS service instance name, so it is visible to anything on the LAN. That is
  the point — it is how a person with two hubs tells them apart before they can
  sign in to either — but it is worth knowing when choosing one.
- **The id is not the name.** `hubId` comes from `<data>/hub-secret.json` on
  the machine's own disk; devices, tokens and saved hubs are keyed by it, and
  renaming touches none of them.

### Why Zigbee is down (`zigbee.problem`)

`connected: false` is a fact with several very different causes, and the cause
used to live only in a log on the hub's own machine — where the person who needs
it, looking at an app somewhere else, cannot reach it. So the hub reads
Zigbee2MQTT's log itself (same service account, no privileges, no SSH) and puts
the answer in the API.

Present only while Zigbee is enabled, not connected, **and** the hub recognised
the failure. Absent otherwise — including for a hub older than the field — so
treat its presence as the signal and never its absence.

```json
"problem": {
  "kind": "firmware-too-old",
  "summary": "The Zigbee coordinator is working, but its firmware is too old for Zigbee2MQTT. …",
  "detail": "error: z2m: Error: Adapter EZSP protocol version (8) is not supported by Host [13-19]."
}
```

| `kind` | Means |
|---|---|
| `firmware-too-old` | The radio answered and refused: its EZSP version predates what Zigbee2MQTT supports. A **new SONOFF ZBDongle-E ships this way**, so this is the common one — flashing it once fixes it. |
| `adapter-unidentified` | Zigbee2MQTT could not work out what kind of coordinator it is. Usually a stick on a plain USB-serial chip with no name of its own. |
| `port-missing` | Zigbee2MQTT could not inspect the USB port (`udevadm` unavailable to the service). |
| `onboarding-pending` | Zigbee2MQTT is waiting on its own browser setup page. `install.sh` turns that off, so this means something reset it. |
| `radio-unreachable` | It reached for the radio and got nothing, with no more specific cause found. |

Branch on `kind` to offer a fix; show `summary` when the kind is unfamiliar — it
is a complete sentence written by the hub, so an app that has never heard of a
new kind still says something true. `detail` is the deciding line from the log,
for a disclosure.

An unrecognised log yields **no** `problem` at all. A wrong diagnosis is worse
than `connected: false`, which the caller already has.

### The MQTT broker asks for a password

The hub's broker used to take anonymous connections from anywhere on the home
network. That was a hole the size of the product: everything a member may do
over this API is behind a token and a role, while anybody on the Wi-Fi could
open a broker connection and publish `zigbee2mqtt/<device>/set` to work every
light and lock in the house — or `bridge/request/permit_join` to open the
Zigbee network — with no credential at all.

`install.sh` now writes two accounts and an ACL. **The apps do not need either
of them to show MQTT traffic**: the `mqtt` WebSocket stream is served by the
hub over the same token everything else uses, so nothing about the apps
changed. These credentials exist for hardware *you* connect.

| | `gethome` (`id: "integrations"`) | `gethome-hub` (`id: "hub"`) |
|---|---|---|
| Who uses it | anything you wire in yourself | hubd and Zigbee2MQTT |
| Publish | `gethome/#` | everything |
| Subscribe | `gethome/#`, `zigbee2mqtt/+`, and `bridge/state`, `bridge/event`, `bridge/devices` | everything |
| Permission to see it | `hub.mqtt` | `hub.mqtt` **and** `hub.mqtt.admin` |

`recommended: true` marks the first one, and an app should lead with it. It can
watch what the home reports without being able to drive it, so a devboard built
against it cannot take the home over if it is lost, resold, or reached by
somebody else. `zigbee2mqtt/bridge/info` is deliberately not readable by it —
that topic carries Zigbee2MQTT's own configuration, and nothing here depends on
upstream redacting the network key from it.

`host` is the address the request arrived on, because the hub reaches its own
broker over loopback and an ESP32 cannot follow it there — a Pi with Wi-Fi and
Ethernet has two addresses and no way to rank them, while the one the app just
used reaches the machine by construction. `MQTT_PUBLIC_HOST` overrides it.

`requiresPassword: false` is a hub whose installer predates all of this. It is
the only way an app can tell "there are no credentials because none exist" from
"you were not given any" — absence would read as the second.

**Reading this writes to the activity log** (`hub.mqtt`), which no other `GET`
here does. That is the point rather than an oversight, and it is what makes
`hub.mqtt` safe to delegate in the matrix: a password cannot be revoked the way
a token can, so the home should be able to see afterwards who was handed one.
Rotating is `gethome-hubctl mqtt --rotate` on the machine itself — root work,
like the radio and the update, and the only real answer to "somebody who had
the password has left".

### Pairing a Matter accessory

**An accessory that has never been on a network cannot be found on one.** A
Wi-Fi Matter plug out of its box — or one somebody has just held the button on
to reset — advertises over Bluetooth LE and nowhere else, because it has no
network to advertise on yet. Its QR payload says so: the
`discoveryCapabilities` bitmap carries BLE and not `onIpNetwork`. A manual
pairing code carries no such field at all, and the hub treats that as *"the
code did not say"* — looking everywhere it can rather than guessing one place.

`GET /hub` carries a `matter` block whenever Matter is running, and an app
should read it before offering the flow:

| Field | Meaning |
|---|---|
| `bluetooth` | whether a factory-new accessory can be found at all |
| `bluetoothReason` | why not: `starting`, `off`, `unsupported-platform`, `not-installed`, `no-adapter`. Each has a different fix, which is why it is not one boolean. **`starting` is not a fault** — the API listens before the adapters do, so for about thirty seconds after every restart the hub has not decided yet; it used to answer `off` there, which means *nobody asked for it* and sends somebody to turn on a radio that is already coming up |
| `wifi` | whether the hub already has a Wi-Fi password to hand the accessory |
| `settlingUntil` | epoch ms until which Matter is still **finding the devices it already owns** — absent once settled. See [below](#a-matter-device-is-not-offline-because-the-hub-has-just-started-looking) |
| `commissioning` | a pairing is running right now, so a second `POST` would be `409` |

**`wifi: false` is what the request's `wifi` field is for.** Taking an accessory
on over Bluetooth means giving it a network — step 11 of the commissioning flow
is `AddOrUpdateWiFiNetwork` — and the hub cannot read the system's own
credentials: the PSK lives in a root-owned NetworkManager profile and the point
of the hub's service account is that it cannot read one. A root dispatcher
writes `/etc/gethome/wifi.env` for it on every association; where that has not
happened (an Ethernet hub, a machine with no NetworkManager, a hub installed
before this existed) the app should ask for the password and send it. It is
never logged and never stored — it goes into the commissioning conversation and
is forgotten with the job.

#### What the hub can hear (`GET /matter/discoverable`)

**Bluetooth range is the one part of pairing nobody can see**, and
`failure.kind: "not-found"` is the same sentence for *"too far from the hub"*
and *"never went into pairing mode"* — two problems with completely different
fixes. An app that cannot tell them apart sends half the people who meet it to
do the wrong thing, after three minutes of waiting to find out.

So the hub can be asked directly, and it is worth asking **before** the code is
committed rather than after the pairing fails:

```json
{ "scannedMs": 6000, "bluetooth": true,
  "devices": [ { "discriminator": 1938, "vendorId": 5130, "productId": 540,
                 "transport": "ble" } ] }
```

`transport` is `ble` or `ip`, and the difference is the accessory's own
situation rather than a detail of the scan: **`ble` means it has no network
yet** (factory-new, or just reset), `ip` means it is already on the LAN and
waiting to be taken on by a second admin. One entry per accessory, and a device
answering on both is reported as `ble`, because that is the half that says what
it still needs.

Two things an app can do with this that it could not do before:

- **Say whether pairing can work, before asking for a code.** "The hub can hear
  an accessory nearby" / "The hub can't hear anything — bring the accessory
  closer to the hub, or plug it in beside the hub to set it up." A Wi-Fi
  accessory only needs Bluetooth range *while it is being paired*; afterwards
  it lives on Wi-Fi and works anywhere in the house, so "set it up next to the
  hub and then move it" is a real answer rather than a fudge.
- **Match a scanned code to what is actually there.** The QR's discriminator
  and one of these are the same number when they are the same accessory — so an
  app can confirm *this* is the device in somebody's hand, or say that the hub
  can hear a different one.

`pairingHint` and `pairingInstruction` are the accessory's own answer to "how
do I put this into pairing mode" (core spec § 5.4.2.4, Table 71), passed
through rather than interpreted: it is the manufacturer talking, and an app
rendering their sentence is right more often than a hub inventing one from the
bitmap.

**It is refused while a pairing is running** (`409 already_commissioning`), and
that is not tidiness. The two would contend for one Bluetooth controller, and a
starved scan does not fail — it reports an empty list. Measured on a Raspberry
Pi Zero 2 W: a second scanner running beside the hub's own took fifteen seconds
of neighbourhood advertisements from **231 down to 2**. An empty list is the
wrong answer in the one direction that matters, because somebody acts on it by
concluding their accessory is broken.

The request is held open for `seconds` and drives a radio, which is why it is
`device.add` rather than the floor: it is the same act as adding a device, one
step earlier, and not something anything should poll.

#### Watching a job

Progress arrives two ways and they cannot disagree, because one function moves
the job and emits the frame: the WebSocket `commissioning` frame, and
`GET /matter/commission/:jobId` for a client that missed one.

`status` is `running`, `done` or `failed` — deliberately unchanged, since a
fourth value is one an existing client would drop on the floor. What grew sits
beside it:

- **`step`** is `looking` or `pairing`, on a running job. It is the difference
  between *"hold the accessory's button until the light blinks"* and *"leave it
  alone now"*, which is the only advice worth giving during the two minutes
  this takes — a screen that says "working…" through both is a screen somebody
  unplugs the accessory in the middle of. It moves on a real signal (a
  candidate reaching the controller's peer set), never on a timer.
- **`failure`** is `{kind, summary, detail?}` on a failed one. `summary` is a
  whole sentence, safe to show as-is for a `kind` an app has never met;
  `detail` is what matter.js actually said, for a disclosure.
- **`deadline`** is when the hub gives up (epoch ms), so a screen counts down
  rather than inventing a patience of its own. Discovery is bounded at three
  minutes — the Matter spec's own minimum commissioning window — and the job at
  four and a half.

| `failure.kind` | What happened |
|---|---|
| `not-found` | nothing answered anywhere the hub could look. Nearly always: the accessory was not in pairing mode |
| `needs-bluetooth` | the code says Bluetooth and this hub has none. **Refused before searching** |
| `needs-wifi` | the accessory has no network and the hub has no password to give it. Refused before searching; ask for one and retry |
| `bad-code` | not a Matter setup code, or its checksum is wrong. Refused before searching |
| `wrong-code` | it answered and would not accept that passcode |
| `already-paired` | still commissioned elsewhere, or out of fabric slots |
| `cancelled` | somebody pressed Cancel |
| `failed` | anything else, carrying matter.js's own words in `detail` |

The three refusals marked *before searching* are the point: in each case the
answer cannot change while somebody waits for it, so three minutes of a spinner
ending in the same word is strictly worse than the word now.

**A cancelled job is `failed` with `kind: "cancelled"`.** That is not laziness —
it is what lets a client that has never heard of cancelling show its ordinary
refusal rather than nothing at all. A client that knows the kind should go
quietly back to its viewfinder instead of drawing a red card for a thing the
person just chose.

`POST /matter/commission/:jobId/cancel` needs the same permission as starting
one, because the hub pairs **one accessory at a time**: a member who could not
call off somebody else's abandoned job could not pair anything either until it
timed out.

### Radio (`GET /hub` and `PUT /settings/radio`)

A board with 1 GB of memory or less is set up for one radio at a time, so what a
hub can talk to is not the same on every machine and an app that assumes
otherwise shows sections that can never fill. **Ask this block; never infer it
from a board name.** The threshold is `MemTotal` against 1024 MB, so a 1 GB Pi 4
and a Pi 3 answer `budget: "one"` exactly as a Zero 2 W does — an app that tells
somebody "a Pi 4 runs both" is wrong for every 1 GB Pi 4 there is. The `radio`
block on `GET /hub` says which situation this hub is in:

| Field | Meaning |
|---|---|
| `budget` | `"both"` or `"one"` — the *board's*, measured at install time. Not a preference and not settable. **Advice, not a ceiling** — see [below](#running-both-radios-on-a-board-measured-for-one) |
| `mode` | `"auto"` (default), `"zigbee"`, `"matter"` or `"both"` — the choice somebody in the home has made, when one has been made |
| `matter` | whether the Matter adapter is **live right now** |
| `canRunBoth` | `budget === "both"`, restated so an app can hide the switch without parsing the enum. It says the board was *measured* for both, never that `both` may not be asked for |
| `modes` | every mode this build understands. Feature detection, never a version number: an app that does not find `"both"` here is talking to a hub too old to run both radios and must not offer it |
| `standDown` | `{at, reason, detail?, count, acknowledged, suspended, willRetry}` — present once this hub has ever handed a radio back by itself. See [below](#running-both-radios-on-a-board-measured-for-one) |
| `pressure` | `{since, detail, willStandDown}` — the board running short of memory **right now**, on any hardware. Live, so it clears on its own |
| `applying` | a switch asked for a moment ago is still landing — see [below](#a-radio-switch-in-flight-radioapplying) |
| `applyingSince` | epoch ms of the request, present only while `applying`, so a screen draws a bar rather than a spinner |
| `applyingWindowMs` | how long the hub is prepared to claim it (150 s), so no app has to invent the number |

`zigbee.coordinator` is the other half of that question and answers the one an
app actually has to draw. `connected: false` used to be two completely
different homes wearing one word:

| Value | What it means | What an app should say |
|---|---|---|
| `"unknown"` | no coordinator has ever been recorded on this machine | *no stick* |
| `"absent"` | one was recorded and its device node is gone right now | *no stick* — it is unplugged, or being reflashed |
| `"present"` | one is plugged in this second | **never** *no stick*. Either Zigbee is starting, or something has stood it down — usually Matter having the board |

The hub cannot see USB itself; `gethome-zigbee-detect` records what it found in
`/etc/gethome/zigbee.env` and this reads it back. Without it, switching a
one-radio Pi to Matter made the app say *"Zigbee · no stick"* about a
coordinator the owner could see from where they were standing.

`auto` follows the hardware **in one direction**: a coordinator takes the board
within seconds of being plugged in, and Matter takes it on a board where no
coordinator has ever been set up. Unplugging a coordinator changes *nothing* —
Zigbee2MQTT stops, the board stays where it was, and switching to Matter is left
to a person. Pulling a stick out is ambiguous (finished with Zigbee, or two
minutes into flashing it?) and the wrong guess restarts the hub under somebody
who is mid-repair. The full matrix, and why Matter never gives way to a
coordinator that isn't there, is in
[zigbee.md](zigbee.md#zigbee-or-matter-on-a-small-board).

So an app looking at `zigbee.connected: false` on a `budget: "one"` hub with
`matter: false` is looking at a board waiting for its coordinator to come back —
offer the Matter switch, don't assume it.

**`PUT` records a request and returns immediately — its response is not state.**
Applying a mode is root work (rewriting `/etc/gethome/hub.env`, stopping or
starting Zigbee2MQTT, restarting the hub), and the hub deliberately cannot do
any of it: it writes one word to a file it owns, a `.path` unit wakes
`gethome-zigbee-detect`, and that applies it. So `matter` in the PUT response is
still the *old* live value, `applying: true` says the switch is in flight, and
the hub will be briefly unreachable while it restarts. Re-read `GET /hub` a few
seconds later rather than trusting the response; a `mode` that is already in
force restarts nothing at all.

The switch is cheap to change your mind about: the coordinator's device path and
Zigbee2MQTT's paired-device list both survive, so devices on the radio that lost
the board come back when it is handed back. They read as offline meanwhile.

#### Running both radios on a board measured for one

`budget` is a **measurement, not a ceiling**, and the distinction is the whole
of this section. It is measured against a *full* home — the operating system,
the hub with Matter loaded, and a Zigbee2MQTT holding a hundred devices' state
— and a home with four devices is nowhere near it. Refusing `both` on a 512 MB
board therefore took Matter away from somebody to prevent a problem they did
not have, so the refusal is gone: **`PUT /settings/radio` accepts `"both"` on
any board.** What `budget: "one"` now means is *recommended one at a time*, and
it is the fact an app warns from.

**What an app owes the person at that switch is one specific sentence**, and it
is the one most easily dropped: *what changes this is your Zigbee network
growing*. Everything else about the offer is reassuring and true — it works now,
the hub watches itself, nothing is unpaired if it stands down — and an app that
says only those has described a setting somebody will meet again in a year with
twenty devices bought on the strength of it. Say what moves the margin, and name
the board that never has the question as **2 GB or more** rather than as a
model.

What makes that safe is that the hub watches itself. While the mode is `both`
**and both radios are actually up**, it samples the kernel's own counters every
30 seconds — the cgroup's `memory.events` `high` (how often systemd's
`MemoryHigh` throttled it), its `oom_kill`, and `MemAvailable` — and if the
board is in trouble across most of a five-minute window it writes `auto` back
and lets `gethome-zigbee-detect` hand a radio over. Throttling rather than
deaths is the point: `memory.high` holds a cgroup at its limit for a long time
before anything is killed, so acting on it means nothing is lost.

Three deliberate silences. Nothing is sampled for the **first two minutes**
after a start — the peak *is* the start (a cold boot reached 170 MB of a 200 MB
ceiling loading `@matter/main`, and a BLE scan afterwards moved the peak by
zero), so sampling through it would stand a radio down on every boot. A counter
read once votes on nothing, because these are totals since boot. And a kernel
that answers none of them — no memory controller, or not Linux — abstains
rather than being guessed at.

**The watch runs on every board; only a small one is acted on.** Two live
radios is the condition, whatever route the board took to them — a hub whose
`GETHOME_RADIO` was edited by hand runs two on `auto`, and so does one in the
seconds between a stand-down writing the mode and the detector applying it. On
a board measured for **both**, a reading that would stand a radio down on a
Zero 2 W instead only *reports*: there is no second radio to hand back, the
board is supposed to run them, and taking one off a 4 GB board would be the hub
making a working home smaller to fix a problem that is somewhere else.

That report is `radio.pressure`, and it is present on any hardware:

| Field | Meaning |
|---|---|
| `since` | epoch ms the board first looked like this |
| `detail` | one sentence naming what was measured |
| `willStandDown` | whether the hub is about to do something about it — *something is about to happen* against *somebody should look at this* |

It is **live**, not a record: it clears on its own when the board recovers, so
an app that was warning stops. The threshold to say it is lower than the
threshold to act (three of ten checks against six), which is also the only
warning a small board gets *before* anything happens to it — about ninety
seconds in which somebody watching their phone can make the choice themselves.

When a radio is actually handed back, `radio.standDown` appears and stays:

| Field | Meaning |
|---|---|
| `at` | epoch ms it happened |
| `reason` | `"memory-pressure"` (throttled or starved — caught **before** anything died) or `"out-of-memory"` (something was killed; the backstop, not the mechanism) |
| `detail` | one sentence naming what was measured, e.g. *the hub was held at its memory limit in 7 of the last 10 checks* |
| `count` | how many times this hub has ever had to do it |
| `acknowledged` | whether somebody has set a radio deliberately since |
| `suspended` | the owner asked for both and the hub is not running them — the choice is **parked, not cancelled** |
| `willRetry` | the hub will try both again by itself |

`count` and `acknowledged` have different lifetimes on purpose. The **notice**
is over the moment somebody chooses a radio — any radio, `both` included, since
choosing one means having seen where the hub left them — which is why
`PUT /settings/radio` is what sets `acknowledged`. The **count** outlives every
acknowledgement, because one stand-down on the afternoon somebody paired eight
bulbs is a board having a bad minute and a fourth is the board answering the
question: an app about to offer this switch again should be able to say so.

It also writes one activity row, `hub.radio-stood-down`, with **no**
`memberId` — nobody did this — carrying `reason`, `detail` and `count` in
`data`. That row is what somebody reads on Thursday wondering why half the
house went quiet on Tuesday.

`auto` rather than a named radio is what gets written back, and that is not a
choice about which radio wins so much as a refusal to invent a second rule for
it: `auto` already means *follow the hardware* — a coordinator somebody went
out and bought takes the board, and Matter takes it where there is none.

#### Getting the radio back

**The hub cannot tell whether both would fit now, and does not pretend to.**
Once a radio has been handed back, the board is no longer running the
configuration that failed — the pressure is gone *because* the second radio is
gone — so no reading it can take answers the question. There is no such number,
and a watch that invented one would have it say yes for ever.

So `suspended` is the hub owing somebody a radio, and a retry is a **trial**
rather than a measurement. It asks about the *machine* instead:

- **the board has restarted** since the stand-down (`/proc/sys/kernel/random/boot_id`
  differs — a service restart does not change it, and the hub restarts itself
  several times in the course of one stand-down). This is the strong evidence:
  a reboot is what puts a memory cgroup into force, what a desktop being
  switched off needs, what clears a process that had wandered off, and what
  happens when somebody moves the card into a bigger Pi;
- **or a week has passed**, which is the weak one and reaches a hub that runs
  for months without a restart. A clock that went backwards is not evidence at
  all, so a record dated in the future falls back to the reboot test.

The budget is **two** automatic tries, because each costs a restart. When they
are spent, `willRetry` goes false and the sentence an app owes somebody is
*the hub has stopped trying, and you can still turn it on*. `PUT /settings/radio`
with `mode: "both"` hands the two tries back — a person deciding is not the hub
flapping, and whatever they know that the hub does not (devices removed, a
desktop switched off, a bigger board) is worth a fresh trial. So is time: a
stand-down more than a week after the previous one starts the budget over,
since two bad afternoons a year apart are not flapping.

A retry writes `both` and is announced like any other switch — `applying`,
`applyingSince`, and a `hub.radio-restored` activity row — so it is a change
with an explanation rather than an unexplained outage. There is deliberately
**no countdown**: the answer to *when* is "next time this board restarts, or
within a week", and a timer to a restart that has to happen anyway is a number
nobody can use.

It also **waits while somebody is pairing** — a Matter commissioning in flight,
or an open Zigbee join window — because a hub that restarted itself mid-pairing
would take the pairing with it. The stand-down never waits: it is the board
being rescued, and deferring it risks the kill it exists to prevent.

#### A Matter device is not offline because the hub has just started looking

Zigbee2MQTT hands its whole device list over in one retained message, so a
Zigbee home is complete a second after the radio is. A Matter controller has to
open a CASE session with every node it owns, in turn, over Wi-Fi — twenty to
thirty seconds on a Raspberry Pi Zero 2 W. And those devices were read back
from the database with the `online: false` they were given when Matter was last
switched *off*, so for that whole window a perfectly healthy home reported
*"1 device offline · needs attention"* about an accessory that was about to
answer.

`matter.settlingUntil` is the hub saying **"I have not finished looking"**. An
app should treat a device on that transport as *connecting* rather than offline
while it is present and in the future: not counted in a needs-attention total,
not drawn with an offline badge.

Three properties matter more than the number:

- **It covers the controller coming up as well as the nodes connecting**, and
  that half was the one this first shipped without. The adapters start *after*
  the API is listening — deliberately, so matter.js opening its storage on a
  slow card cannot hold the health check and the claim closed — so every
  `GET /hub` in those seconds was answered by an adapter that had not begun
  looking at all, reporting a settled home while `radio.matter` already said
  `true` because the adapter had been constructed. The two phases are bounded
  separately, because a clock running while matter.js loads is a clock counting
  time in which no node *could* have reported in: charging it to the nodes
  would shorten the window they actually get, on precisely the boards slow
  enough to need all of it.
- **It clears when the last node connects, not when the clock runs out.** The
  controller knows what it is commissioned to and what it has reached, so there
  is nothing to guess — a hub whose devices all answer in four seconds stops
  making excuses after four seconds.
- **Every clock here is a bound, not a promise.** The node window is only ever
  *reached* by a node that is genuinely not there — the one real offline
  device — and the start-up window only by a `start()` that never returns.
  Neither may hide an unreachable device behind "still looking" for ever.

Absent means settled. The whole `matter` block is absent on a hub with no
Matter running, which is the same presence-is-the-capability rule as
everywhere else here.

#### And how long it takes to notice one has gone

The mirror of the section above, and the question a real hub provokes: a
mains-powered Matter socket pulled out of the wall reads offline **two to four
minutes later**, not at once. That is the protocol working rather than a fault,
and it is worth writing down because it looks exactly like a fault.

Matter has no ping. A controller learns a node is gone when the node stops
feeding a **subscription**, and how long that takes is a device-type decision
matter.js makes for us. It asks for a maximum report interval of one minute for
a mains-powered Wi-Fi or Thread node, three minutes for a Thread sleepy end
device, **ten minutes for a battery-powered one**, or an intermittently
connected device's own idle-mode duration — plus up to ten per cent of jitter,
so a home's accessories do not all report on the same second. The subscription
is then declared timed out at that interval *plus twice the MRP peer-response
budget*, which is itself tens of seconds. Only after that does matter.js probe
the peer's address, close the session, and try once to re-subscribe; when that
attempt fails it reports the node not-live, which is the `stateChanged` the
adapter turns into `reachabilityChanged('matter', id, false)` and the registry
writes to `devices.online`.

So the sum for an unplugged mains socket is roughly: ~70 s of keepalive window,
~35 s of response budget, a failed probe, and a failed re-subscribe.

**The case where the delay would actually matter is already fast.** Any
exchange whose MRP retransmissions are exhausted calls `peerLost`, the CASE
session is deleted, and the node drops to *Reconnecting* immediately — so a
**command** sent to a device that is no longer there marks it offline within one
MRP budget, seconds rather than minutes. The slow path is only the passive one,
where nobody has touched the device and the hub is waiting on a keepalive.

**Do not reach for `subscribeMaxIntervalCeilingSeconds` to shorten it.** It is
one number for every node the hub connects, applied at `connect()` — before the
hub knows whether it is talking to a mains plug or a door sensor — so a 30 s
ceiling to make one socket prompt would take the battery default from ten
minutes to thirty seconds and pay for that impatience out of somebody's sensor
batteries, for ever. matter.js says the same thing in its own API docs: it
"tries to set meaningful values based on the device type, connection type, and
other details", so do not set it unless you know better than that.

For scale: Zigbee2MQTT ships with per-device availability tracking **off** and
the config `install.sh` writes leaves it off, so a Zigbee device that dies is
not marked offline at all until the bridge itself goes down. Two to four
minutes is the *tightest* answer this hub currently gives about a device that
has silently stopped answering.

#### A device that is meant to be offline

Somebody unplugs a heater for the summer. It is offline, and it is not a fault
— but nothing could say so, so the dashboard counted it, put *Needs attention*
over the home and went on doing it until the thing was plugged back in. The
person who unplugged it is the only one who knows, and the only thing they
could do about it was ignore a warning for four months.

`PATCH /devices/:id { offlineExpected: true }` is them saying it. The device
comes back carrying `offlineExpected: { at, by? }` — the moment, and who said
it — and an app draws it as offline **without counting it as something needing
attention**. `false` takes it back, which is what somebody does after plugging
the socket back in and finding it still does not answer.

It is the **house's**, not a phone's dismissal, and that is the whole of why it
is a column on the device row rather than something each app remembers. One
person unplugs the heater; nobody else in the home should go on being told the
home needs looking at. It is under `device.edit` for the same reason: silencing
the home's own alarm for everybody is not something a guest staying the weekend
should be able to do — unlike `favorite`, which sits in the same body and needs
nothing.

**It is an excuse for *this* absence, not for the device.** The hub clears it
the moment the device is reachable again, so a socket excused in May, plugged
back in and pulled out again in September is a new thing to be told about. That
is a per-device report doing the clearing, never the *radio* coming back up:
`radioReachabilityChanged` speaks for everything behind it and is an assumption
rather than a report, and Zigbee2MQTT's bridge says `online` on every hub
restart — which would have cleared every excuse in the home overnight, on a hub
nobody had touched. Nothing is hidden by holding them across that: while a radio
is down its devices are already explained by the resting-radio rule in both
apps, and the first real report that the device is back ends it properly.

Setting it writes one `device.offline-expected` activity row, and only when it
is a change — an app re-sending what the hub already holds says nothing worth
reading a week later. The automatic clear writes nothing of its own: the device
coming back already writes `device.online`, and two lines for one event is the
burst the feed's whole shape exists to avoid.

#### A radio switch in flight (`radio.applying`)

Applying a radio **restarts the hub** — around seventy seconds of a closed port
on a Zero 2 W. That is the whole difficulty of reporting it: the process that
took the request is killed by the thing it was asked to do, so an app polling
across the gap saw a refused connection, then a hub reporting the old radios,
then the new ones, and drew *"can't reach your hub"* over a change somebody had
just made deliberately.

So the moment is written to the hub's data directory rather than held in
memory, and `GET /hub` reports it from there — which means it survives the
restart it is describing. An app that finds `applying: true` should say the hub
is switching radios and treat an unreachable hub as *expected* until
`applyingSince + applyingWindowMs`, rather than as a fault.

**It ends when the hub is in the arrangement that was asked for, or when the
window runs out** — whichever comes first, and both halves are load-bearing.
A mode names the *whole* arrangement, so each one asserts what must be **off**
as well as what must be on: asking only whether the wanted radio was up was
right for every switch that turns one on and wrong for every switch that turns
one off. Leaving `both` for `zigbee` left Zigbee already connected, so the
switch read as landed the instant it was recorded — no progress bar, no planned
downtime — and the hub then went off the network for seventy seconds with
nothing on screen to say why. `both` → `matter` had it too. `both` is still the
one mode that lands in two stages, and is over only when both radios are up. A mode change that
resolves to the radio already running (`auto` → `matter` on a hub already on
Matter) is one the detector correctly answers by restarting nothing, and the
window alone left every app drawing "switching radios" over a hub that was
never going anywhere. The window is what covers the other direction: asking for
Zigbee on a hub with no coordinator is a reasonable thing to do, correctly
changes nothing, and has no target that will ever be live — so it has to end by
timing out. `auto` always uses the window, because it names no single radio to
check against.

### Which member you are (`isSelf` and `PATCH /members/me`)

`GET /members` marks the caller's own row:

```json
[{ "id": "…", "name": "Georgy’s MacBook Pro", "role": "owner",
   "roleId": "…", "roleKey": "owner", "roleName": "Owner",
   "createdAt": "…", "isSelf": true }]
```

`role` is the legacy two-word string and stays for apps written before roles;
`roleId`/`roleKey`/`roleName` are the real answer, and the one to render. Note
that `role` says only *whether this is the owner* — a Guest and a member of a
role somebody invented both read `"member"` there, which is exactly why an app
must not infer what somebody may do from it.

It is there because nothing else answers the question. The member id is returned
exactly once, by `POST /pair`, and the shorter route on the hub's own machine —
`gethome-hubctl claim` — prints the hub id and the token and no member at all,
so a client that claimed over SSH holds a working token and no idea which of
these names is its own. Additive: a client that ignores it loses nothing.

`PATCH /members/me {"name": "…"}` → the member shape above plus `permissions`,
renaming whoever the bearer token belongs to. Addressed as `me` for the same reason: the token
already says who this is, and asking for an id as well only adds a way to get it
wrong. **Any member may rename itself** — the owner-only rule guards the shape
of the home, not what somebody calls themselves — and renaming *another* member
is not offered. Names are trimmed and must be 1–80 characters after trimming;
`POST /pair` applies the same rule. A rename posts `member.renamed` to the
activity feed, and a name that is already in force writes nothing.

An app that lets a device claim a hub should say what that name will be and let
it be changed later: GetHome Studio, which has no accounts and no user name of
its own, offers the Mac's own name and renames through this route from the hub
page.

### Signing in again (`POST /invites` with a `memberId`)

**A person is a member row; a device is a token row.** Everything personal on
this hub hangs off the first — the AI conversations in
`automation_chat_messages.member_id`, the lines attributed to somebody in the
activity log, their own favorites, the name the whole home reads. Every arrival
used to insert a member, so a second phone, or the same phone after the app was
deleted and installed again, walked in as a stranger with the same name and left
all of it behind on a member nobody could ever sign in as again.

A sign-in code fixes that by naming the person on the code:

```
POST /invites  {"memberId": "…"}      →  201 {code, expiresAt, memberId, memberName, roleId: null, roleName: null}
POST /pair     {"code", "memberName"} →  200 {token, member}   // the member already here
```

**Ask `GET /hub` for `pairing.signInCodes` first, and offer nothing without
it.** Presence is the capability, as it is for `history` and `portraits` — but
here the reason is sharper than "don't draw a button that can only fail". An
older hub parses this body with a schema that has never heard of `memberId`,
and zod *strips* what it does not know, so the request **succeeds** and mints an
ordinary invite. Claiming that adds exactly the duplicate person this exists to
prevent, and nothing on the way back says so.

Deliberately the **same** route, table, 15-minute expiry, single use, per-address
rate limit, `claimId` replay and `/pair` endpoint as an invite — two ways to mint
one code beats a second code with its own way of being wrong. `memberId` is the
only thing that tells them apart, on `POST` and in `GET /invites` alike, where
`null` means an invite; there is no derived `kind` beside it, because that would
be a second copy of one fact.

Four things follow from it.

**The name on the claim is ignored.** The code says who this is, and a field
somebody fills in on a reconnect screen must not rename them for the whole
house. `PATCH /members/me` is where a rename lives. An app should show the name
that comes *back*, which is the member's own.

**The token they already had keeps working.** This is "another device", not
"moved to a new phone" — a tablet and a phone are two tokens on one member.
Ending access is still `DELETE /members/:id`, which takes every token with the
row.

**Who may ask is asked of the body**, which is why this route is authenticated
with the check inside rather than gated at the door — the shape `PATCH
/devices/:id` already has, and for the same reason: one field decides which
question to ask.

| Code for | Needs | Why |
|---|---|---|
| yourself (`memberId: "me"` or your own id) | **the floor** | It grants exactly the authority you are already holding a token for, and anyone who can ask could copy that token to the other device instead. The companion to `PATCH /members/me` and `DELETE /members/me` |
| somebody else | `member.invite` | That permission's own sentence — putting a person into this home — with the person already named. What it adds over minting them a fresh invite is their *history*, not authority: whoever can invite could already create a peer at any non-owner role |
| somebody holding the **owner** role | the caller must be an owner (`403 not_owner`) | There the identity **is** the authority. Without this, `member.invite` — which a home may hand to a role it invented — would quietly mean "become the owner", and every other key would be a formality. The same guard `POST /invites {roleId: owner}` and `PATCH /members/:id` carry |

**Minting one for somebody else writes `member.signin-code` to the activity
log**; minting your own writes nothing. Handing over an identity for fifteen
minutes is what makes `member.invite` safe to delegate only if the home can see
who did it — the reason reading the broker password writes a line — while
logging every "and my tablet too" would be noise in a feed read a week later.
Claiming writes `member.signed-in` rather than `member.joined`, because somebody
picking up their tablet is not a person arriving; the device is named in the
**sentence** and deliberately not in `data.deviceName`, which means a device *in
the home* everywhere else in the log.

**Removing a member takes their outstanding codes with them.**
`invites.member_id` is a column added by `ALTER TABLE`, so SQLite gives it no
`ON DELETE` action — the `invites.role_id` situation exactly — and the raw
foreign key would otherwise turn an ordinary removal into a 500. Both delete
routes clear the codes first, which also closes the fifteen-minute window in
which a removed member could have let themselves back in.

One rollback note. The column is additive, so a build from before it ignores it
and would admit a sign-in code's holder as a *new* member — the behaviour this
replaces, for a code minted in the minute a failed build was live.
`createSignInCode` writes `role`/`roleId` as the role that member currently
holds so that even then they arrive at the right level; nothing on the current
path ever reads them back.

### Leaving and removing (`DELETE /members/me`, `DELETE /members/:id`)

Both answer `204` and both really do end that member's access, on both
channels. The row's tokens are deleted with it (`tokens.member_id` cascades,
and this hub runs with `foreign_keys = ON`), so every later request is a `401`
— and **any WebSocket that member is already holding is closed**, with code
`4001`, before the departure is written to the activity log.

That second half is not implied by the first. A socket authorizes once, when
it opens, so the token cascade alone would have left the connection they
already had streaming device state until it happened to drop — a hub restart,
a Wi-Fi blip, possibly days. `4001` is the same code an unauthorized socket
gets on connect, deliberately: it means the same thing, and a client that
already stops reconnecting on it needs no change. Closing before the log write
is what stops a removed member receiving, as their last frame, the
announcement of their own removal.

`DELETE /members/me` is **leaving**, addressed as `me` for the same reason
`PATCH` is, and open to any member: whether to stay in somebody's home is the
one decision about a member that is entirely their own. `DELETE /members/:id`
is **removal**, and is the owner's.

**The last owner can do neither**, to itself or through anyone else — `409
cannot_remove_owner` from both routes — and taking an owner out of the home at
all needs the caller to be one (`403 not_owner`). An owner who has made somebody
else one can leave like anybody else; the only one left cannot, because a home
with no owner has nobody who could grant the role back. An owner finished with a
hub and alone in it is finished with the hub, which is `gethome-hubctl` on the
machine rather than a route.

Each writes one activity entry — `member.left` or `member.removed` — naming the
member in the message and carrying **no `memberId`**. That is deliberate twice
over: `activity.member_id` is a foreign key, so naming a row that has just been
deleted fails the insert and naming one about to be deleted would be nulled by
the cascade; and a departure is the one entry whose subject can never be looked
up afterwards, so the name has to live in the sentence. Clients watching the
`activity` WebSocket stream get both, which is how a member list stays right
without polling.

### Rooms and zones

A home has **rooms**, and rooms may sit in a **zone**: "Upstairs", "Garden",
"Guest house". A room in no zone is the ordinary case, not a gap to fill in.

It is deliberately a zone and not a floor. A flat has no floors and a garage
isn't one, so a *floor* field asks every home that isn't a house either to
leave it blank or to lie in it, while a zone that happens to be called "Second
floor" covers the house perfectly. It is also Apple Home's own word (`HMZone`),
and the GetHome app shows Apple Homes beside hub homes — one vocabulary for
both.

Rooms and zones are shared, so a change made on one phone has to reach the
others without waiting for them to reconnect — which, before this, was the only
thing that ever re-read them. Every write to either broadcasts one frame
carrying **both lists in full**:

```
{"type":"structure","rooms":[{id,name,zoneId,icon,accent,sortOrder}],"zones":[{id,name,sortOrder}]}
```

Both, because a client redraws its zone sections from the pair and sending half
would make every app hold the other half from memory; in full, because a home
has a handful of each and a diff is a way to be subtly wrong for less than it
costs to send. A client that has never heard of the frame ignores it and keeps
re-reading on `hello`, as it always did.

Deleting is the case worth knowing: **a deleted room keeps its devices** (they
end up in no room, and the hub says so on the socket for each of them), and a
**deleted zone keeps its rooms**. Neither is a way to lose anything.

#### How a room looks is the house's too

`icon` and `accent` are a glyph token and a palette token, stored beside the
name for the same reason the name is stored at all: everybody who opens the
home should see the same kitchen, in the same colour.

**Null is the ordinary state, and it means "you decide".** Apps derive a glyph
from the name — a room called Garage draws a car — and hand out colours in
turn, so a room nobody has styled stores nothing and looks exactly as it always
did. A value is somebody having overruled that, and it wins from then on;
writing `null` hands the room back to the app's own judgement.

The hub does not police the vocabulary. Which glyphs exist, and what `sky`
looks like, belong to the apps — an allowlist here would mean a hub upgrade
every time one of them added a colour, and the cost of a token an app doesn't
recognise is that it falls back to the derived look. They are bounded (1–40
characters) because a token is a word, not a payload.

Changing a room's look is **not** written to the activity log, where a rename
is. That log is read a week later, and "somebody changed the kitchen's colour"
is not what anyone is looking for in it; the `structure` frame above still
tells every open app the moment it happens.

#### What a structural edit writes to the log

Reshaping the home writes one line each: **`room.added` · `room.renamed` ·
`room.removed` · `zone.added` · `zone.renamed` · `zone.removed` ·
`device.renamed` · `device.moved`**, naming the member who did it and what
they touched — the whole vocabulary and the `data` each kind carries is in
[the activity log](#the-activity-log).

Two deliberate silences, and both are the same rule: **an edit is logged when
it changes what other people see, not when it changes how it looks to them.**
A room's `icon`/`accent` write nothing, and neither does the order rooms are
listed in — that one never reaches the hub at all, because it is each phone's
own preference (see the GetHome app's `CLAUDE.md`).

### Which room a rule is in

Every automation on the wire carries `roomId`: **the one room every device the
rule touches sits in**, or `null`. It is what lets an app put a rule on the page
of the room it belongs to instead of only in one long list, and say on the
rule's own page whose room it is.

`null` is the ordinary answer for a rule about the whole house, and it means one
thing — *this rule is not one room's*. Four ways to get it: the rule reaches
into two rooms, it touches a device nobody has placed yet, it touches no devices
at all (a button that only writes a line in the history), or the only room it
named has since been deleted.

**It is derived on every read and stored nowhere.** A rule's room is a function
of the document *and of the home as it is right now*: a selector picks up a lamp
paired next month, and a device moved from the Kitchen to the Hall changes which
room a rule belongs to with the rule untouched. A column would be a second copy
of that going stale in the dark. The consequence for a client is the one worth
knowing: **`roomId` can change without an `automation` frame**, because nothing
about the automation changed — so re-read the list when the structure it is
derived from moves (a room or zone written, a device added, removed, or moved to
another room), not only when a rule does.

Two halves to how it is worked out, and the second is why a resolver alone would
not do:

- **A selector naming a room declares one.** "Every light in the Kitchen" is the
  Kitchen's rule on the day it is written, before anybody has paired a lamp.
  Everything such a target resolves to is in that room by construction, so
  naming it is the whole of that target's answer.
- **Everything else is resolved against the home**, exactly as the engine
  resolves it — triggers, conditions (nested ones included) and actions, plus a
  toggle's off-actions. A rule that *watches* the Kitchen and switches something
  in the Hall is not the Kitchen's, and a walk that looked only at what a rule
  does would have said it was.

A `runAutomation` action is deliberately not followed: the rule it names is its
own rule, with its own room and its own page.

### Favorites are per member

`favorite` is the **caller's** pin. `GET /devices` answers a different value to
each member, `PATCH /devices/:id {"favorite":true}` pins the device for whoever
sent it, and the `deviceUpserted` frame is rendered per socket for the same
reason.

It used to be one boolean on the device row, which quietly made a favorite a
property of the *home*: one person pinning the kettle put it on everybody's
dashboard, and the next person to unpin it took it off yours. Names and rooms
are shared because they describe the house; a favorite describes a person.

The wire is unchanged — still a field called `favorite`, still a boolean — so
an app written against the old shared flag reads its own favorites without
knowing anything happened. Existing pins were carried over to every member the
hub had at upgrade time, since "everyone can see this" is the honest reading of
a flag that was shared. The `devices.favorite` column still exists and is
maintained as the union of everybody's pins; nothing reads it, and it is there
only so that rolling back to an older build (which `install.sh` does by itself
when a new one fails its health check) meets a schema it understands.

### Device wire shape (`GET /devices` item)

```json
{
  "id": "8b6c…uuid", "externalId": "0x54ef44100047fea7",
  "name": "Desk lamp", "roomId": null,
  "favorite": false, "online": true,
  "adapter": "zigbee", "vendor": "IKEA", "model": "LED2003G10",
  "needsReview": false,
  "endpoints": [{
    "endpointId": 1, "deviceKind": "light", "primaryCapability": "onOff",
    "capabilities": ["onOff", "level", "colorTemperature"],
    "state": { "reachable": true, "onOff": true,
               "level": {"current": 203, "min": 1, "max": 254},
               "colorTemperature": {"mireds": 370, "minMireds": 250, "maxMireds": 454},
               "sensors": {} }
  }]
}
```

**`online` and each endpoint's `state.reachable` are one fact, and a client
should read whichever it prefers rather than combining them.** The hub keeps
them in step — the guard in `reachabilityChanged` asks whether *either* is
behind, so a restart that loaded the two out of step from their separate
tables is repaired the next time a radio reports, and the correction arrives
as an ordinary `deviceUpserted` frame with no activity row behind it (nothing
about the device changed; one of the two records of it was late). They drifted
once, and an app ANDing them showed a device as offline while another app,
reading `online` alone, showed the same device online at the same moment.

`id` is a UUID this hub minted; **`externalId` is the device's address on its
own protocol** — a Zigbee IEEE, an MQTT discovery id, a Matter node. It is the
only handle an app has for tying a device row to something a *radio* said,
because the Zigbee lifecycle stream (`zigbeeEvent`) is keyed by IEEE and knows
nothing about the hub's UUIDs. Without it a pairing screen watching both had no
way to tell that "New device fea7" finishing its interview and "Smart
temperature and humidity sensor FEA7" arriving were one sensor, and drew them
as two. It is stable for the life of the pairing and is not a secret — it is
what Zigbee2MQTT and every MQTT integration already call the device.

`needsReview: true` marks devices whose automatic mapping was incomplete
(see [ai-adaptation.md](ai-adaptation.md)).

`online` is **whether the hub can reach the device**, and it answers for the
radio as well as for the device. A radio that is switched off, failed to start,
or lost its Zigbee2MQTT bridge takes every device behind it `offline` — with a
`deviceUpserted` frame each, exactly as one device going would. That is what a
one-radio board looks like after `PUT /settings/radio`: half the home reads
offline until the radio is handed back, and reads online again when it is.
Without it those devices would have kept the `online` they had before the
switch, since reachability only ever arrives from a radio that is running.

`recognition` is additive and says **how** the device came to be understood:

```json
"recognition": {
  "source": "static",
  "uncovered": [],
  "unmapped": ["power_on_behavior"],
  "exposesHash": "3f2a…64 hex"
}
```

`source` names the *highest layer that was needed* — `static` (typed
capabilities, no key and no cost), `custom-fields` (some parameters are
reachable only as generic controls), `ai`, `imported`, or `none`. `uncovered`
is what `needsReview` is about: properties with no representation at all.
`exposesHash` identifies the device *model*, and so its entry in the mapping
library. Absent on a device adopted before the hub recorded it, which an app
must read as "not known" rather than "recognised by nothing".

### Updating the hub

A hub can update itself when asked. That is what lets a phone do it — GetHome
Studio drives `gethome-hubctl update` over SSH with a key it planted at install
time, and an iPhone has no such thing.

**The hub records the request; it never applies it.** Updating means writing
`/opt/gethome`, moving the `current` symlink and restarting a systemd unit — all
root, none of it something a network-facing process should be able to do. So
`POST /system/update` writes one line into the hub's own data directory,
`gethome-update.path` notices, and `/usr/local/lib/gethome-update.sh` does the
work as root. The same trade `PUT /settings/radio` makes, for the same reason:
no sudo rule, nothing new to lock down.

Three consequences for a client, and none of them is optional.

- **The response is a receipt.** Nothing has happened yet, and this process is
  about to be restarted by what happens next. Poll `GET /system/update`.
- **The hub goes away in the middle, on purpose.** `install.sh` restarts it, and
  on a Zero 2 W coming back is over a minute. A failing poll during a run is the
  expected state, not evidence of anything — an app that concludes "unreachable"
  there is wrong for the two minutes it matters most.
- **What is running afterwards comes from `GET /hub`'s `build`**, never from the
  log. `version` reads the same before and after an update, which is why the
  stamp exists.

```jsonc
// GET /system/update
{
  "current": { "build": "0.1.0-1590564-main", "version": "0.1.0",
               "sha": "1590564", "channel": "main" },
  "latest":  { "sha": "a86c1dc", "checkedAt": "2026-08-24T18:00:00Z" },
  "available": true,
  "canApply": true,
  "run": {
    "id": "8c1f…", "state": "running", "step": "download",
    "startedAt": "…", "finishedAt": "…", "heartbeat": "…",
    "fromBuild": "0.1.0-1590564-main", "liveBuild": "0.1.0-a86c1dc-main",
    "hubAnswering": true, "warnings": ["…"], "error": "…"
  }
}
```

**`available` is absent when the hub cannot tell**, and that is the field's whole
point. Nothing anywhere knows what "the latest build" is: `bundle-main` is a
rolling release that always exists and always moves, so the only answer is to
compare the commit inside `build` against the head of `main`, which the hub asks
GitHub for. That call can fail — no internet, a rate limit (unauthenticated
GitHub allows sixty an hour per address, and one hub is one address for every
phone in the house) — and a hub built from source has no commit to compare at
all. Each of those sets `checkError` (`offline` / `rate_limited` /
`no_build_stamp`) and leaves `available` out. **A missing `available` read as
`false` tells somebody they are up to date on the strength of a failed network
call.** The check is lazy and cached six hours: a hub nobody asks never calls out.

`canApply` is whether this machine has the runner and the units at all. A hub
installed before they existed answers `false` — and one older still has no route
here, so a `404` means the same thing and is the honest thing for an app to
report. The way out of both is one update from Studio, after which the hub can
update itself.

**`state` is five-valued and two of them are easy to get wrong.**
`succeeded` / `failed` are what they sound like. **`rolled-back` means the new
build wouldn't start and the hub put itself back — the hub is up and healthy**,
and reporting it as a failure is the wrong sentence to show somebody whose home
is working. It is a separate state because the installer cannot say so with its
exit status: it ends in failure either way and the `current` symlink points at
the same build either way, so `install.sh` prints a `@@ROLLBACK@@` marker and the
runner reads that. `stalled` is a run whose heartbeat stopped — the board lost
power, or the OOM killer took the runner — and it exists so that one power cut
does not leave a progress bar that never moves and a `409` on every attempt to
try again. `running` is the rest.

The outcome also reaches the activity log as a `hub.update` row, written at the
next boot: the hub cannot record its own update while it is being restarted by
it. The request is recorded straight away, with the member's name.

**Why `hub.update` is a key, and why Member starts with it.** It was owner-only
first, on the reasoning that an update is not quite "bringing something new in" —
it replaces the code everybody depends on. What that missed is who the owner
*is*: GetHome Studio claims a hub as *the Mac*, so the owner is a laptop in a
drawer, every phone joins by invite as a plain member, and [there is no ownership
transfer](#which-member-you-are-isself-and-patch-membersme) to fix it with. The
rule therefore did not mean "an update needs care"; it meant the phone in the
owner's own hand could never update their own hub, for the life of that hub.
Found on the first one this shipped to — the same discovery that moved renaming a
device out of `ownerOnly`.

So it went to every member, which was right about the household and wrong about
the mechanism: "every member" is not something a home can revisit, and this is
exactly the kind of thing a home might want kept away from whoever is staying in
the spare room. As a permission it is both — the default hands it to Member, so
nobody who could update yesterday has lost anything, while Guest arrives without
it and either can be moved from the matrix.

The default passes the three tests every default here passes. **Bounded**:
`install.sh` unpacks beside the running build and only moves the symlink once the
new one answers, so a build that won't start puts itself back unattended.
**Destroys nothing**: no device leaves, no membership ends — and migrations are
written to be readable by the build before them, which the automatic rollback
turns from a hope into a rule. **Named**: the `hub.update` row carries the
member's name.

Reading is the floor rather than a key of its own, and deliberately: somebody who
*cannot* press the button is exactly who needs to see why the home went quiet for
two minutes.

Taking something *away* is still guarded harder — a device, a member, the
credential that spends their money. That line has not moved.

### The Zigbee join window

`POST /zigbee/permit-join` opens the network for `seconds` and the hub owns
what happens next. Three things follow from that, and a client should not
reimplement any of them.

**Any member may open one**, and every open and close is written to the
activity log with their name on it — see the roles note under
[REST routes](#rest-routes).

**A window is made of grants.** The Zigbee protocol carries a permit-join
duration as a uint8 of seconds, so **254 is the most a single grant can last**.
A longer window is several grants, re-issued by the hub, with the last one
*sized to land exactly on the deadline* rather than overshooting it. Asking for
900 is therefore fine; asking a hub older than this field for anything past 254
is a 400, so treat `zigbee.permitJoin` being present as the capability check.

**Zigbee2MQTT is the authority.** The hub reconciles against `bridge/info`, so
a window somebody opened from Z2M's own UI is adopted and reported, and a
`permit_join: false` closes ours whatever we intended. It fails closed: a hub
that restarts mid-window leaves at most one grant running and nothing renews it.

**The state is on `GET /hub`, not only on the event stream.** An app that has
just been opened, or has just reconnected, has no other way to learn it — which
is how GetHome Studio came to draw "Close Network" over a network that had shut
two minutes earlier. `permitJoin` frames repeat every five seconds while the
window is open, which is the right rate for a network message and the wrong one
for a countdown; drive the seconds from a local clock and re-sync on each frame.

### The AI settings answer

`GET /settings/ai` carries every flat field it always did — an app that predates
the second provider reads exactly what it read before — plus a per-provider half:

```json
{
  "provider": "anthropic", "model": "claude-opus-5", "hasKey": true,
  "enabled": true, "legacySubscriptionToken": false,
  "status": { "lastRun": { "at": "…", "ok": true, "costUsd": 0.41, "model": "claude-opus-5" } },

  "anthropic": { "hasKey": true,  "model": "claude-opus-5" },
  "openai":    { "hasKey": true,  "model": null },
  "mappingChoosable": true,

  "providers": {
    "anthropic": { "hasKey": true, "model": "claude-opus-5",
                   "models": [ { "id": "claude-opus-5", "label": "Opus 5",
                                 "note": "The most thorough. Every recognition run uses it.",
                                 "recommended": true } ] },
    "openai":    { "hasKey": true, "model": "gpt-5.6-sol", "models": [ … ] }
  },
  "mapping":   { "provider": "anthropic", "choosable": true },
  "assistant": { "model": "claude-opus-5",
                 "models": [ { "id": "claude-opus-5", "label": "Opus 5",
                               "note": "The most capable. Best at a house it has to work out.",
                               "recommended": true },
                             { "id": "claude-sonnet-5", "label": "Sonnet 5",
                               "note": "Quicker and cheaper. …" } ] },
  "portraits": { "model": "gpt-image-2.5-flare", "maxPerDevice": 6, "budgetBytes": 314572800 }
}
```

Four things an app should not work out for itself.

**The model list is the hub's.** `providers.<name>.models` carries the id, a
label a person reads, a one-line note and exactly one `recommended`. This is the
`GET /permissions` rule applied to models: ids and tiers move, and an app that
shipped its own list would offer one this hub refuses or miss one it accepts.
The allowlist behind it is deliberately longer than `models` — a hub already set
to an older model keeps working rather than being told its setting is invalid,
and a run recorded months ago still prices correctly when its log is read back.

**`models` is one entry per provider, so draw it as a fact, not a picker.** The
cheaper tier was retired after it produced descriptors the hub had to reject and
one that named `custom` as an outlet's primary capability — a paid run whose
result was a tile with no control on it. An app should show which model
recognition runs on; keep the picker for the day the list is longer than one,
and don't hide the row when it isn't, because which model spends the home's
money is worth stating even when it isn't a question. **`model` is what will
run, not what is stored**: a setting naming a model no longer offered resolves
to the one that is, so an app never draws a model this hub will not use. Writing
a retired id is still accepted — it just isn't what runs.

**`assistant` and `automations` are a different question from `providers`, and
they really are pickers.** `providers.<name>.models` answers "which model reads
a device's exposes tree"; those two answer "which model answers in the
assistant" and "which model writes the home's rules", and the lists differ
because the trades do. A mapping descriptor is cached against a device model and
shapes every unit of it the home ever meets, so a cheaper tier that is wrong
once is wrong for ever and the list is one entry long. A conversation is many
small rounds, read the moment they arrive and answered with another message when
the reply is poor — so what a round costs is a real choice, and those lists have
two. Write them with `PATCH /settings/ai {assistantModel}` and
`{automationsModel}`; `null` clears either back to the default. As above, both
`model` fields are what will **run**, and a stored id this build no longer
offers resolves to the default rather than being refused.

**The two agents are offered the same two models and choose separately**, which
is the point of them being two blocks: answering questions about the house and
writing the rules it runs by itself are different jobs, and a home may want to
spend differently on them. `automations` is new — that agent used to read
`providers.anthropic.model`, the *mapper's* choice, which never showed because
that list offers one model and Sonnet is not on it, and was one added choice
away from making "which model recognises a device" silently decide "which model
writes a rule".

**`provider` and `mapping.provider` are the same answer**: which provider would
recognise a device right now. With one key there is no choice to make; with two,
the home's stored choice decides, and `mapping.choosable` is what an app shows
its picker on. A stored choice only counts while that provider still has a key,
so clearing a credential moves the answer rather than leaving the hub pointed at
something it cannot authenticate.

**`hasKey` is "can the agent run at all"** — either credential — because that is
the question `409 ai_not_configured` answers. Whether *Anthropic* is configured
is `providers.anthropic.hasKey`.

**`enabled` governs adaptation only.** It exists because the agent runs by
itself when an unknown device turns up; nobody draws a portrait by accident, so
portraits are not gated on it.

Key material is never returned, by any route, in any field.

### Device portraits

A portrait is the picture the apps float on a device's page, and it is the
**house's**: everybody in the home sees the same kettle, so it is drawn once on
the hub and stored there rather than on whichever phone asked for it. The hub
already knows the device's canonical `kind`, so a caller sends nothing but
"draw this device", optionally with a photo to restyle — which is also what
keeps two apps from producing two different-looking homes.

Drawing needs an **OpenAI** key (`gpt-image-2.5-flare`, which supports
transparent backgrounds and is used for a clean cut-out).
Recognition may be running on Anthropic at the same time, which is why the
refusal is `openai_not_configured` rather than `ai_not_configured`.

The bytes are files under `<data>/portraits/`, not rows: a 1024² transparent PNG
is a megabyte or two, and putting that through SQLite's WAL is the write
amplification the whole store is arranged to avoid. The row is the record of
one, and the file is deleted with it.

**Two bounds and a floor**, the shape every other store here has. Six per
device; 300 MB per hub, sweeping oldest-first; and a refusal to draw at all
below 500 MB of free disk — filling the card the home runs on is a far worse
outcome than not getting a picture. **A selected portrait is never evicted**: it
is the one on screen. Drawing takes the selection, so the newest is always the
one the home is looking at.

`selected: null` while portraits exist is a **state, not an absence** — it means
somebody chose the procedural sphere over every picture they have, which the
apps have always offered and which would otherwise need a field of its own.

Drawing is serialised hub-wide (`409 portrait_busy`) and synchronous: the
request is held for the minutes an image takes, which is what lets an
app run one uninterrupted animation from "reading your photo" to the finished
portrait. If the phone gives up or walks out of range the hub finishes, stores
and announces anyway — nothing is lost but the animation. Every change
broadcasts `{"type":"portraits","deviceId"}` to every socket, because the phone
in the next room is looking at the same device.

Only the *drawing* is written to the activity log (`device.portrait`). Choosing
between portraits and deleting one are restyles, and a restyle is not what
somebody reads the log for a week later — the same line `rooms.icon` holds.

**What a drawing cost goes in `ai_runs`, and who asked goes on the picture.**
They are two questions with two lifetimes, which is why they are stored in two
places rather than one.

A portrait is the third thing that spends the home's money on AI, so every
drawing writes one `ai_runs` row (`kind: "portrait"`, `adapter: "portraits"`)
beside the mapping runs and the conversations — the price, the wall-clock
`durationMs` and the model, in the one table whose whole argument is that *what
did this home spend on AI* is a single question and three tables would be three
screens answering it. `portraitId` links the row to the picture it bought, the
way `automationId` links a chat's row to the rule it wrote; `exposesHash` is
empty, that column being about a device model. A **failed** draw is recorded
too, with the provider's own `errorKind` and sentence, because it is what
answers "why did nothing happen" a day later — and it buys no picture, so
`portraitId` is null.

The price is read off the provider's own `usage`, never estimated from the size
and quality we asked for: 2.5 bills per token, so the response is the only thing
that actually knows. When it reports none, `costUsd` is **absent rather than
zero** — `$0.00` is a claim and "nothing was reported" is the truth, the line
`ai_runs` already holds for a conversation whose spend row has been pruned. And
when the response gives no `input_tokens_details`, the whole input is priced at
the dearer image rate, since there is then no way to tell a prompt from a
reference photo and an estimate that reads low is the one that surprises
somebody.

Per-portrait spend is therefore answerable only while that run row lives:
`ai_runs` keeps the last 250 runs of every kind, and a chat writes one per turn,
so a picture can outlive its own price. That is the same trade the conversations
already make, and it is the reason **`drawnBy` is on the portrait row instead**.
The drawing is in the activity log with the member on it, but that log is bounded
at 5 000 rows and 30 days while a portrait has no age bound at all — so the log
is not where "who drew this" can be read from a season later. The member's *name*
is copied beside the id for the activity log's own reason: the column carries no
`ON DELETE` action (SQLite gives an `ALTER TABLE` column none — the
`invites.member_id` situation), so the id may point at somebody who has since
been removed, and the row read next week is all that is left of them.

### The device-mapping library

`GET /device-mappings/:exposesHash` returns an **envelope**, not a bare
descriptor, because a descriptor does not say which device it is for:

```json
{
  "gethomeDeviceMapping": 1,
  "adapter": "zigbee",
  "vendor": "TuYa",
  "model": "TS0601_thermostat",
  "exposesHash": "3f2a…",
  "descriptor": { "version": 1, "endpoints": [ … ] }
}
```

`PUT` accepts either that or a bare descriptor — both are things a person
plausibly has in a file. An envelope whose own `exposesHash` disagrees with the
one in the URL is **accepted and flagged** (`hashMismatch: true`), not refused:
a mapping written for a device one firmware revision away is the case this
exists for, and the sanity checks still have to pass either way.

A document the hub cannot use is a **422 with the reasons, and it is stored**.
That is the difference between a dead end and a step: `POST …/repair` hands the
draft and the exact complaints to the agent. Only `repair` needs a credential —
listing, downloading, uploading and deleting are local operations on JSON.

### The activity log

The home's history: what people did through the apps, and the handful of things
that happened to the home itself. It is a feed somebody scrolls, not an audit
trail, and everyone who may read it reads the same one, by name — there is no
filtering by device, room or kind, and nothing in it is private *from the people
who can see it*. That is deliberate for a family home.

**`activity.read` decides who that is, and it narrows rather than refuses.** A
member without it still receives their own rows, on `GET /activity` and on the
socket alike, so their Recent feed is a working screen instead of a 403 — and
"what have I done in this house" is a fair question for anyone standing in it.
Rows with no `memberId` (a device dropping off the network, somebody leaving)
belong to nobody and are correctly absent from that view. Guest is the role that
ships without it.

The socket's filter is applied **at send time**, not captured when the socket
authorized, so granting somebody `activity.read` while their app is open starts
the house arriving on the next line, with no reconnect and nothing to poll.

```json
{
  "id": 4127,
  "at": "2026-08-22T09:14:02.482Z",
  "kind": "device.command",
  "message": "Anna · Desk lamp: setLevel",
  "deviceId": "…", "memberId": "…",
  "data": { "command": {"type":"setLevel","level":180},
            "deviceName": "Desk lamp", "memberName": "Anna" }
}
```

`message` is the whole sentence and is all a client needs — Studio renders
exactly that. `data` is the same facts structured, so an app can compose its
own wording ("Brightness set"), pick an icon and a tone, and fold a burst of
commands into one line; the GetHome iOS app does. Both names are copied into it
because `member_id` and `device_id` are `ON DELETE SET NULL`: a row read next
week may be all that is left of a device somebody has since removed. `data` is
**optional everywhere** — rows written before it existed have none, and so do
kinds with nothing to add.

The kinds: `device.command`, `device.added`, `device.removed`,
`device.online`, `device.offline`, `device.renamed`, `device.moved`,
`device.portrait`,
`room.added`, `room.renamed`, `room.removed`, `zone.added`, `zone.renamed`,
`zone.removed`, `member.joined`, `member.signed-in`, `member.signin-code`,
`member.left`, `member.removed`,
`member.renamed`, `member.role-changed`, `role.added`, `role.renamed`,
`role.changed`, `role.removed`, `home.renamed`, `hub.radio`,
`hub.radio-stood-down`, `hub.radio-restored`, `hub.mqtt`, `adapter.error`,
`zigbee.interview-failed`, `zigbee.left`, `zigbee.permit-join`,
`zigbee.permit-join-closed`, `matter.commission`. Treat the list as open — a
client must render an unknown kind from `message` rather than drop it.

The five that move access — `member.role-changed` and the `role.*` four —
carry `data.memberName` (who did it) and `data.roleName`, with `previousName`
on a rename and `subjectName` on `member.role-changed` — which
`member.signin-code` uses too, for the person the code was made for. A permission edit
records **a sentence, never the diff**: this log is read a week later, where
"Georgy changed what Guest can do" is the whole of what anybody is looking for,
and the [`access` frame](#what-you-may-do-access) is what tells an app that is
open right now. Restyling a role — like restyling a room — writes nothing.

The seven that reshape the home — the `room.*` and `zone.*` trio each, plus
`device.renamed` and `device.moved` — carry `data.memberName` and the name of
what was touched (`roomName`, `zoneName`, `deviceName`), with `previousName`
on the renames and `roomName` absent on a device taken out of every room. See
[what a structural edit records](#what-a-structural-edit-writes-to-the-log)
for the two things that are deliberately *not* logged.

The last three, plus `hub.radio`, all carry `data.memberName`: they are the
things any member may do to the whole home, so the log is where it says which
phone did. `hub.radio-stood-down` and `hub.radio-restored` are the two entries here with
**no member at all** — the hub handed a radio back by itself and later gave it
another go, and naming somebody would be attributing a decision nobody made.
They carry `reason`/`detail`/`count` and `attempt`/`count` instead. A feed that
showed only the first would read as a hub that keeps taking things away; both
are [described above](#running-both-radios-on-a-board-measured-for-one). `zigbee.permit-join` also carries `data.seconds` — the **live**
window the hub ended up with, not the number that was asked for.
`matter.commission` is written when pairing *starts* and never carries the
pairing code: that is the accessory's credential, and every member reads this
log.

**What is not in it: state.** A device *reporting* — a power meter every few
seconds, a thermostat every minute — writes nothing here, the same rule that
keeps `STATE_FLUSH_MS` debouncing state rows onto an SD card. Only commands and
discrete transitions are recorded, which is also why a wall switch somebody
flips by hand is invisible: the hub logs what it was asked to do, plus a device
dropping off the network or coming back. `device.online`/`device.offline` are
silent for the first minute after start-up, because a reconnect sweep is the
hub catching up rather than something that happened in the house.

**Retention is two bounds, whichever bites first: 5 000 rows and 30 days.** The
row cap protects the disk; the age cap protects relevance, because 5 000 rows
is three days in a busy home and a year of nothing in a quiet one. Pruning runs
at most once an hour, hung off the next write rather than a timer, so the table
sits at the cap plus whatever has happened since the last pass — and a hub where
nothing is happening never wakes up to prune. There is no route to clear it and
no setting to change it.

### Recorded readings (`GET /devices/:id/history`)

What the temperature, the humidity or the power draw actually did, over the last
few days. The hub knew what a reading *is* — `endpoints.state` is one row,
rewritten in place — and had no way to say what it *was*.

**At most one row per five minutes per quantity, never one per report.** This is
the same line the activity log holds, for the same machine: a power meter
reports every few seconds, forever, onto an SD card. Readings are accumulated in
memory (`src/core/history.ts`) and a closed bucket lands as one row carrying its
low, its high, and the running total and count the mean is computed from. About
288 batched transactions a day; a week of an ordinary home is one to two
megabytes.

**"At most" matters**: a bucket nothing reported in writes no row, so a sensor
that speaks every ten minutes costs one row per report rather than one per
bucket.

A one-minute bucket was tried and reverted. It buys the *timing* of a spike and
nothing else — the band already carries the low and the high of everything
inside a bucket, so a kettle that ran for ninety seconds shows as a tall band
either way — and five times the rows on every chatty meter is the wrong trade
for that. An hour is thirteen bucket indices, which an app draws as a curve by
marking the points when a series is sparse.

**The bucket being filled right now is served from memory**, so the chart ends
*now* rather than up to five minutes ago — which matters because the live value
is usually on screen right beside it.

Retention is **two bounds**, like the activity log's: seven days, and 500
distinct recorded quantities. The age bound is also the row cap per quantity
(2 016, and only a device reporting in every single bucket for a week reaches
it), so the only axis that could grow without limit is how many quantities a
home has, and that is what the second bound is for.

Reading it is the **floor** — a temperature chart is the home being read, the
same answer `GET /devices` gives.

```
GET /api/v1/devices/<id>/history?from=1756108800000&to=1756195200000&points=300&series=temperature,humidity
```

```json
{
  "start": 1756108800000,
  "bucketMs": 300000,
  "end": 1756195200000,
  "retentionDays": 7,
  "series": [
    { "kind": "temperature", "unit": "centiCelsius", "gapBuckets": 6,
      "leading": { "at": 1756108200000, "min": 2130, "max": 2150, "avg": 2140 },
      "points": [[0, 2140, 2180, 2160], [1, 2150, 2190, 2170], [7, 2050, 2060, 2055]] }
  ]
}
```

Five things about that shape are load-bearing:

- **A point is `[offset, min, max, mean]`**, and `offset` counts `bucketMs` from
  `start`. Tuples rather than objects because a week of one series is hundreds
  of points and the field names would be most of the payload.
- **A gap is a missing offset.** Not a null, not a zero — the offsets that
  aren't there *are* the hole. In the example above nothing was recorded between
  offsets 1 and 7. Drawing a line through it would be the hub claiming to know
  something it doesn't; a device that is offline reports nothing, so its silence
  is a real absence.
- **`gapBuckets` says how long a hole has to be before it stops being a lull**,
  derived per series from its own observed cadence (the median spacing times
  four, floored at three points and capped at two hours of wall time). A fixed
  threshold gets one of the two cases wrong every time: a sensor that reports
  twice an hour drawn as permanently broken, or an afternoon of silence drawn as
  perfectly steady.
- **`bucketMs` is what the hub chose, not what it stores.** A week is 2 016
  five-minute buckets and a phone draws a few hundred points, so the hub thins to
  `points` (default 360, max 1 000) by folding whole buckets together — the band
  still reaches the real extremes — and states the width it used. Never assume
  five minutes.

  The fold is **rounded up to a width a clock recognises** (5, 10, 15, 20, 30,
  60 minutes, and so on): plain division lands on "every 25 minutes", which is
  honest and reads as a glitch in an app that prints that width and labels a
  time axis with it. And `points` means *at most* this many — an hour touches
  **thirteen** bucket indices rather than twelve, so a caller who wants every
  stored bucket of one asks for more than twelve.
- **`leading` is the reading *before* the window**, and it is optional. A chart
  drawn from `points` alone begins wherever the sensor happened to speak — for a
  sensor reporting every twenty minutes, an hour opens a third of the way across
  with empty axis to its left, which reads as "nothing recorded" when the hub
  knows perfectly well what the temperature was. This is the other end of the
  segment that crosses `from`, so an app can draw the line *entering* the window
  instead of starting in mid-air. It is **not a reading inside the window** and
  must not be charted as one: no marker, no place in a scrub, no contribution to
  a min/max readout.

  `at` is **epoch ms, not an offset** — it does not sit on the emitted grid.
  It is bounded by that series' own `gapBuckets`: past that the silence is a
  hole, there is nothing honest to join to, and the field is **absent** rather
  than null. Only the hub can answer this, which is why it is not left to an app
  widening its own `from`: that would change the span, and with it the emitted
  `bucketMs`, so asking for context would silently coarsen the whole chart.

  What happens at the **other** edge is deliberately not here. Whether to hold
  the last reading out to the right of the window is a drawing decision about a
  stretch both ends already agree is empty, and the app has `gapBuckets` to make
  it with; this field exists because only the hub can reach data the app does
  not have.

Values are **integers in the canonical wire units**, so nothing is converted
between the device report and the chart:

| `kind` | `unit` | from |
|---|---|---|
| `temperature` | `centiCelsius` | `sensors.temperatureCenti` |
| `humidity` | `centiPercent` | `sensors.humidityCenti` |
| `illuminance` | `lux` | `sensors.illuminanceLux`, rounded |
| `pressure` | `deciHectopascal` | `sensors.pressureHPa` × 10 |
| `co2` | `ppm` | `sensors.co2ppm` |
| `pm25` | `deciMicrogramsPerCubicMetre` | `sensors.pm25` × 10 |
| `flow` | `milliCubicMetresPerHour` | `sensors.flowCubicMetersPerHour` × 1000 |
| `power` | `milliwatt` | `power.activeMilliwatts` |
| `battery` | `percent` | `battery.percent` |
| `thermostatTemperature` | `centiCelsius` | `thermostat.localTemperatureCenti` |

The three quantities the wire carries as floats get an explicit scale here
because a `REAL` column costs eight bytes a value where a varint costs one or
two, and a whole lux or a tenth of a hPa is far below anything a chart shows. An
unknown name in `series=` is **dropped rather than refused**, so an app one
version ahead still gets the rest of its chart.

One quantity reported on several endpoints of the same device — a two-channel
meter — folds into one line: the device page asks about the device.

Booleans are deliberately **not** here. "When was the light on" wants transitions
rather than buckets and a step chart rather than a line; that is a different
table and a different control, not a widening of this one.

## WebSocket

`GET /api/v1/ws?token=<token>` upgrades to a WebSocket. One JSON frame per
message. These go to every authorized socket:

```
{"type":"hello","hubId","name","apiVersion":1,"streams":["mqtt","zigbee","ai"],"permissions":[…]}
{"type":"access","role":{id,key,name},"permissions":[…],"roles":[…]}   what *you* may do
{"type":"state","deviceId","endpointId","state":{…}}    full canonical state after each change
{"type":"deviceUpserted","device":{…}}                  new device or structure/name change
{"type":"deviceRemoved","deviceId"}
{"type":"commandFailed","deviceId","property","kind","detail"}   a write never reached the device
{"type":"structure","rooms":[…],"zones":[…]}            rooms/zones changed — both lists in full
{"type":"portraits","deviceId"}                         a device's portraits changed — go and re-read the list

{"type":"activity","entry":{id,at,kind,message,deviceId?,memberId?,data?}}
{"type":"permitJoin","active":true,"remainingSeconds":60}
{"type":"commissioning","jobId","status","detail"?,"step"?,"failure"?,"deadline"?}
                                                        Matter pairing progress — see above
{"type":"hubStatus","zigbee":{…},"radio":{…},"matter"?:{…}}
                                                        a radio came up, went down, or was switched
```

### A write that didn't land (`commandFailed`)

`POST /devices/:id/commands` answers **202-shaped success for anything it can
route**, and that is not a bug to be fixed at the route: routing is all it can
do. The Zigbee adapter publishes to `<base>/<name>/set` and MQTT resolves as
soon as the *broker* takes the message; Zigbee2MQTT has no per-command reply
topic, and the device may be a battery sensor that is asleep. So "the hub
accepted it" has never meant "the device did it", and a client that asks for a
value and watches the old one come back had no way to tell **still on its way**
from **refused**. Both apps papered over that by silently reverting, which is
the worst of the three answers.

```json
{ "type": "commandFailed", "deviceId": "…", "property": "detection_interval",
  "kind": "unreachable", "detail": "Device did not respond to attribute write" }
```

Four things to know.

**It is a report, not a rejection.** It arrives long after the command's own
response, carries no request id, and changes nothing the hub has stored — the
hub keeps what devices *report*, so a failed write leaves its state already
correct. The optimistic value is the client's, and the client is who this is
for.

**It goes to every socket**, like `structure` and for the same reason: the
value being written is the house's, so the phone in the next room is drawing
the same setting with the same wrong value on screen.

**`kind` is open**, deliberately a string rather than a union. Adapters
classify in their own vocabulary, a client that meets a word it doesn't know
falls back to `detail`, and a hub that learns a new one must not need every
client updated first. Zigbee answers two:

| `kind` | Means | What a client should say |
|---|---|---|
| `unreachable` | The device never answered. On a **battery** device this is ordinary rather than a fault — a sleeping end device takes a queued write when it next checks in. | "Waiting for the sensor" — and, for a battery device, that waking it applies it now |
| `refused` | The device or Z2M said no. | `detail`, in the protocol's own words |

**And a `superseded` write never arrives**, which is the one case worth naming
because it is the common one. When a person taps − four times, each write goes
into the queue for a sleeping device and each is cancelled by the next:
zigbee-herdsman reports four errors reading `Request superseded` for a value
that is about to be set correctly. That is not a failure, it is the queue
working, and it is dropped twice — in
`adapters/zigbee/write-failures.ts` where the log line is classified, and again
in the registry, because the registry is the seam a second adapter will arrive
at. Clients that coalesce their own writes (the GetHome app debounces a
stepper) rarely produce one at all.

**Where it comes from.** `bridge/logging` — the third bridge topic the Zigbee
adapter relays rather than drops, and the narrowest read of one. It is the only
place the outcome of a `set` is written down. Reading another project's prose
is a real cost and the same rule applies here as in `diagnosis.ts`: an
unrecognised line yields nothing, because a wrong diagnosis is worse than the
silence the caller already has.

### What you may do (`access`)

Rendered **per socket**, like `deviceUpserted` and for the same reason: it is
the reader's own answer, not the home's. It arrives once behind `hello`, and
again on **any** access write anywhere in the home — a role created, renamed,
edited or deleted, or somebody moved between roles.

```json
{
  "type": "access",
  "role": { "id": "…", "key": "guest", "name": "Guest" },
  "permissions": ["activity.read"],
  "roles": [{ "id": "…", "key": "owner", "name": "Owner", "builtin": true,
              "permissions": [ … ], "memberCount": 1, "sortOrder": 0 }]
}
```

It carries the roles list too, because a client drawing "Anna — Guest" needs
those names and a second round trip for four rows is a round trip nobody needed.

**That list is why every write reaches every socket**, and it is worth being
precise about, because the narrower rule looks obviously right and is not. The
frame has two halves with two audiences: `role` and `permissions` are personal,
while `roles` — the whole table, each row carrying its own `memberCount` — is
the home's. Sending only to the members holding the role that changed got the
personal half right and left the shared half stale everywhere else: a role
somebody *created* reached nobody (a new role has no holders), a role they
*deleted* the same (it is refused while held), an owner editing Guest heard
nothing about their own edit, and moving one person between two roles left both
`memberCount`s wrong on every other screen. Every client rendering the matrix
saw it move only when the page was closed and reopened. A broadcast is not a
leak — each socket still renders its own answer, and the role table is readable
by every member anyway.

**Without it, an app sits looking at controls that have quietly stopped
working** until something else happens to make it refetch — the same argument
that put `structure` and `hubStatus` on the socket. It is not a poll and not a
heartbeat: it fires on the change.

A hub older than this sends no `access` frame and no `permissions` on `hello`.
That is "this hub has not said", never "you may do nothing" — fall back to the
old rules.

### When a radio comes or goes — or is switched (`hubStatus`)

Pulling the Zigbee coordinator out of a running hub produces two facts, and
only one of them used to travel. Zigbee2MQTT stops, so every Zigbee device goes
unreachable — those arrive as `deviceUpserted` frames, one per device. *Why*
they went is the `zigbee`/`radio` picture, and that only ever reached a client
through `GET /hub`, which nothing asks for at that moment. Apps drew a home
half offline under a chip still reporting Zigbee as live.

The frame carries **the same two blocks `GET /hub` answers with**, built from
the same snapshot (`src/core/hub-status.ts`) so a client is never told two
different things depending on which arrived first. Three rules:

- **It fires on the transition, not on a timer.** A join window's countdown has
  its own frame at its own rate; this one would otherwise repeat the whole
  status every five seconds while a network is open.
- **It is sent before the device frames.** The devices say *what*; this says
  *why*, and an app told in the other order has nothing to explain the grey
  cards with until it asks.
- **Absence still means nothing.** A hub older than these fields sends no
  frame and no blocks, which is not the same as reporting both radios off —
  the same rule that governs `radio.budget`.

**It also fires when somebody records a new `mode`.** A radio switch is a
change to the home that any member may make, and the other app in the house
has to see it — but `PUT /settings/radio` writes a file and returns, and the
hub restarts afterwards *only* when the change actually moves Matter. So a
client cannot wait for its socket to bounce: switching between two modes that
resolve the same way changes `mode` and restarts nothing. Polling is not the
answer either, since not every app polls — the GetHome iOS app doesn't, so a
switch made in GetHome Studio never reached the phone at all. The frame is
sent from the route, and carries a **stale `matter`** for the same reason the
response does: what is live comes from the adapters, a moment later.

Note what this does **not** do: pulling a coordinator out does not switch a
one-radio board to Matter. That is deliberate and is covered in
[zigbee.md](zigbee.md#zigbee-or-matter-on-a-small-board) — removal is
ambiguous, so the board stays put and a person decides with
`PUT /settings/radio`. The frame is what makes that decision an informed one.

### Opt-in streams

`hello` advertises which of the four optional streams this hub can serve, so a
client never has to infer it from a version number — a hub with the MQTT
adapter off simply lists fewer. Ask for the ones you need:

```
→ {"type":"subscribe","streams":["mqtt","zigbee","ai","automations"]}
→ {"type":"unsubscribe","streams":["mqtt"]}
← {"type":"subscribed","streams":["zigbee","ai","automations"],"unavailable":["mqtt"]}
```

and then:

```
{"type":"mqttBacklog","frames":[…]}                     once, on subscribing to "mqtt"
{"type":"mqtt","frame":{seq,at,topic,channel,direction,payload,truncated,payloadBytes,retained}}
{"type":"mqtt","dropped":N}                             rate limit hit; N frames skipped
{"type":"zigbeeEvent","event":{at,type,ieee,name?}}     joined|announced|interviewing|interviewed|interview-failed|left
{"type":"aiRun","event":{phase,id,at,kind,exposesHash,vendor?,model?,step?,ok?,costUsd?,error?}}
{"type":"automationRun","run":{automationId,name,at,trigger,cause,outcome,commands,refused,detail?}}
{"type":"automationChat","chat":{sessionId,phase,at,text,kind?,detail?}}  phase: thinking | delta | step | turn | amend
{"type":"assistantChat","chat":{…the same shape…}}      the assistant, on the same stream
```

**The assistant rides the `automations` stream too, deliberately.** A job the
assistant hands over is an *automations* conversation, so an app drawing a
handoff card has to receive both kinds of frame for one screen — asking it to
subscribe twice for that is a contract that will be got wrong once. One
subscription, two frame types, told apart by `type`.

Both carry their payload under their **own key** rather than the `event` that
`zigbeeEvent` and `aiRun` use. That is not tidiness: a typed client decodes one
envelope for every frame, so a second shape under a key it already has makes
every automation frame fail to decode and takes the socket message with it.

`automationChat` has **four phases, because a spinner is not an answer to "what
is happening"** (and a fifth that is not about a round at all — see `amend`
below): one line per thing the agent did (`step`), its own summarized
reasoning as it arrives (`thinking`), the reply as it is produced (`delta`), and
the end of an exchange (`turn`) — after which the stored transcript is what to
draw. A round is tens of seconds of the model reading the home and deciding
before a word of the reply exists, so a client with only `delta` had a spinner
for the longest part of every one; a step goes up *before* each request, and the
reasoning fills the rest. Being the highest-rate frames the hub can emit and of
interest only to the one client with the chat open is why they are opt-in.

On a `step`, **`kind` is what an app draws a mark from** — `reading` ·
`checking` · `writing` · `asking` · `thinking` — and it names the *shape of the
act* rather than the tool, so a client draws seven tools with five marks and the
hub can grow an eighth without an app release. Open string, the
`commandFailed.kind` rule: an unknown word gets a neutral mark and keeps its
sentence. See [`docs/automations.md`](automations.md) for the vocabulary.

**`amend` is not a round.** The other four are one exchange happening; `amend`
says a row already *in* this transcript has changed and should be re-read,
while whatever round is on screen carries on untouched. One thing sends it
today: a handoff card's status, which is written when the **other** agent
finishes a turn and can therefore land at any moment, including in the middle
of a round of this conversation. It goes out on the conversation the *card* is
in, which is the assistant's — sent under the delegated session's id an app
re-read the chat where nothing had changed and left the card on "working" until
the page was closed and reopened; sent as `turn` it took the live round's trail
down with it. A client too old to know the word falls through to re-read and
clear, which is where it was before.

**A stored round carries one kind the socket never sends.** `data.steps` on a
transcript row can hold `kind: "said"` — prose from a round that then went on to
call a tool, kept because only the *last* round's text becomes a row and that
narration would otherwise exist nowhere. No `step` frame goes out for it: the
words already reached the client as `delta`s while they were being written, and
a frame would draw the same sentence twice. A client that folds its own streamed
prose into its live trail therefore ends up with the same trail either way. A
step's `detail` can likewise now hold the model's **reasoning**, hung on the step
it was produced under wherever the tool sent no sentence of its own.

**`automationRun` is opt-in for the same reason the others are.** It is the
trace somebody watches while working out why the light came on, and a home with
a motion rule produces one every time anybody walks through the hall. The
*change* frame is not opt-in and arrives on every socket:

```
{"type":"automation","automationId":"…"}   created, edited, enabled, switched on, removed
```

because a rule is the **house's** — somebody switching "Night" on in the
kitchen has to reach the phone in the bedroom drawing the same card, which is
exactly why `structure` and `portraits` are always-on too. It carries the id and
nothing else: `GET /automations` is a short read, and a payload here would be a
second shape for a fact that already has one.

**They are opt-in because they are not free.** The MQTT tap is a wildcard
subscription on the broker and can be thousands of messages a minute; attaching
it to every socket would make a phone showing a room of lights pay for a
developer tool it never opens. A socket that never subscribes never has a
listener attached, and the hub connects to the broker only while at least one
client is watching — with a minute of linger, so switching screens and back
does not clear the log. Nothing about that traffic is written to disk: it is a
stream a person watches, not a record, and one row per sensor report onto an SD
card is what the registry's state debounce exists to avoid.

Frames are rate-limited per socket and the losses are **reported rather than
hidden** — a gap nobody is told about is worse than a gap. `mqttBacklog` is the
few hundred frames the hub had buffered when you subscribed; there is no
history before that, and an app should say so rather than implying otherwise.

A payload over **8 KB** arrives cut, with `truncated: true` and `payloadBytes`
giving the size of the whole message. In practice that is the two retained
Zigbee2MQTT registries — `bridge/devices` and `bridge/definitions`, hundreds of
kilobytes to megabytes of reference data — and nothing else: a device report is
a few hundred bytes and the bridge's own status topics are one to three
kilobytes. **Show the reader how much is missing rather than naming the limit**,
which is a number in this repository that an app cannot keep in step, and don't
offer a "copy the payload" that quietly hands over the cut copy. Nothing else in
the hub sees a cut payload: the adapters hold their own broker connections and
the observer is a separate, read-only tap.

Unauthorized sockets are closed with code `4001`. Clients should reconnect with
exponential backoff and re-`GET /devices` after reconnecting (frames may have
been missed) — but **not on `4001`**, which is the hub saying this token is no
good. It carries two cases and neither is fixed by trying again: a token that
never authenticated, and one belonging to a member who has since been removed
or left, whose live socket is closed with the same code the moment their row
goes. Treat it as a stop, and say so; every other close is worth retrying.

## Errors

`400 {error:"invalid_body", issues:[…]}` (zod), `401 unauthorized`,
`403 {error:"forbidden", permission:"<key>"}`, `404 not_found`, `409` for
protocol-level refusals (unsupported command, adapter disabled,
`cannot_remove_owner`, `cannot_change_owner`, `not_owner`, `role_is_owner`,
`role_is_builtin`, `role_in_use`).

**A refusal names the permission**, because "the hub said no" leaves a person
with no idea what to ask for; turn it into a sentence naming the thing, not the
role — a home that has edited its matrix may have granted it to Guest and
withheld it from Member. `403 owner_only` was the old shape and is gone; a
client that still recognises it loses nothing by keeping the branch for older
hubs.
