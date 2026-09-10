# `src/ai/` — the AI subsystem

Loaded when Claude works with files under `src/ai/`. The root `CLAUDE.md`
carries the rules from here that bind code outside this directory; everything
else about the mapper, the agents and the chat runtime is below.
`docs/ai-adaptation.md` and `docs/assistant.md` are canonical for their
domains — update them in the same change.

- **AI mappings are data, not code**: `MappingDescriptor`
  (`src/ai/descriptor.ts`) is zod-validated and interpreted. Never execute
  model output. The mapping is produced by an autonomous agent with
  `submit_mapping` as its only answer channel and backoff on account failures
  (`docs/ai-adaptation.md` is canonical), authenticated with the home's own API
  key.
  **There are two agents and one run.** `src/ai/agent-core.ts` holds everything
  that is not a vendor's API — the guardrails, the `AgentStep` vocabulary, the
  `submit_mapping` schema, `evaluateSubmission`, the `MappingProvider` seam —
  and **imports no SDK**, which is the load-bearing half: a home configured with
  only an OpenAI key must never load the Anthropic SDK to satisfy an import
  chain, so `resolveProvider()` imports whichever half it needs. `agent.ts` is
  the Anthropic loop (Messages API, server-side `web_search`/`web_fetch`);
  `openai-agent.ts` is the same run on the Responses API over plain `fetch` —
  no second SDK for a Pi to download — with hosted search and a `fetch_page`
  the **hub itself** performs, because OpenAI has no hosted equivalent and
  reading the device's own zigbee2mqtt.io page rather than a search snippet is
  the difference between settling a unit and guessing one, on a mapping cached
  against a device model for ever.
  **That is the one place this repository opens a connection to a site that is
  not a provider's API, and an allowlist is the whole of why it is
  acceptable.** `src/ai/page-fetch.ts` reads `zigbee2mqtt.io` and
  `raw.githubusercontent.com` and nothing else: the URL comes from model output
  and the machine dialling is inside somebody's home network with an
  unauthenticated health route of its own, so a general fetch tool here is a
  request-forgery primitive aimed at the LAN dressed up as research. Five
  guards — https only; the host matched exactly or as a subdomain *with the
  dot*, since `endsWith` would accept `evil-zigbee2mqtt.io`; redirects
  followed by hand and re-checked every hop, because `fetch` follows them
  itself and an allowed host answering `302 http://10.0.0.1/` would walk
  straight past the list; the resolved address required to be public, because
  an allowlist on a *name* is only as good as the resolver behind it; and
  bounded bytes with one deadline. `test/ai-page-fetch.test.ts` asserts that a
  refused URL produces **no request at all**, which is what proves the guard
  runs before the fetch rather than after it. `docs/ai-adaptation.md`'s Privacy
  section is canonical and says what the promise narrowed to.
  Three rules for the pair. **The system prompt is built per provider**
  (`mappingSystemPrompt`), because its research paragraph names tools and the
  two loops do not carry the same ones: one shared prompt told an OpenAI run
  to `web_fetch` the device's zigbee2mqtt.io page first, called that page the
  source of truth, and then told it not to spend searches confirming what it
  had already read — three instructions about a tool it has not got, at the
  one point in the run where research is decided. Everything else in it is
  shared, so a rule added for one vendor cannot go missing for the other, and
  `test/ai-boundary.test.ts` asserts the wall for both.
  **Effort is `high` on both and is not exposed**: two
  settings for one decision is one too many. And **the hub owns the model
  list** — the apps render `providers.<name>.models` rather than shipping ids of
  their own, the `GET /permissions` rule applied to a vocabulary that moves.
  **That list is one model per provider now, so the apps *state* it rather than
  ask.** It was two, the thorough tier and the cheaper one, until the cheaper
  one was tried: Sonnet 5 kept submitting descriptors `submit_mapping` had to
  bounce, and the run that finished named `custom` as an outlet's primary — the
  one value that renders as no control at all, so a paid run produced a dead
  tile on a working plug. The trade is lopsided because a descriptor is cached
  per device *model* and shapes every unit of it the home ever meets until
  somebody remaps; a few cents on a job that runs a handful of times in a hub's
  life does not buy that risk. OpenAI's cheaper tier went on the same reasoning
  rather than its own evidence. The half that is easy to miss is
  **`effectiveModel`: a stored model counts only while it is still offered**,
  or retiring one leaves the homes that had chosen it as the only homes still
  running it — silently, since nothing on a screen would change. `GET
  /settings/ai` answers what will *run*, never the column, so a hub set to
  Sonnet moves to Opus by itself; a write naming a retired id is still accepted
  rather than 400-ing an older app, it simply is not what runs, and `PRICING`
  stays broad so a months-old `ai_runs.modelId` still prices correctly.
  **`resolveProvider()` has to use it too, and that is the half that was
  missed.** Every surface that *reports* which model answered went through
  `effectiveModel` — the settings route, `ai_runs.modelId`,
  `status.lastRun.model`, the backoff gate's credential id — while the one
  call that picks the model to actually run read the column, so a hub set to
  Sonnet went on running Sonnet with every screen and every recorded row
  saying Opus. It passed unnoticed because `isSupportedModel` is deliberately
  the broad `PRICING` allowlist and let it straight through, and because the
  homes it was wrong for are exactly the ones nobody was looking at.
  `test/ai-model-choice.test.ts` pins it.
  **It used to run on the Claude Agent SDK, and moving off it was a memory
  decision like dropping Docker.** That SDK ships a 276 MB native binary — 74%
  of the hub's whole download — and spawned a ~315 MB subprocess per run, of
  which ~224 MB is mapped binary pages. On a Zero 2 W that thrashes against
  the SD card instead of OOM-ing and outlives the 10-minute watchdog, so AI
  adaptation was installed-but-unusable on the smallest supported board. The
  bundle went 117 MB → 29 MB. The cost is that Claude subscription tokens no
  longer authenticate; only API keys do, and `src/ai/models.ts` is an
  allowlist because the `_20260209` research tools need Opus 4.6+/Sonnet 4.6+.
  **The Anthropic turn is streamed, and a mock that is laxer than the SDK is
  how that went unnoticed.** `messages.create` refuses a non-streaming request
  whose `max_tokens` could run past the API's ten-minute ceiling — the line is
  21,333 and `MAX_OUTPUT_TOKENS` is 32,000 — so every run threw before it
  reached the network, and because that refusal carries no HTTP status
  `classifyApiError` read it as a transport failure: a run that could never
  work armed the backoff gate and retried for ever, with the real cause behind
  a retry timer. `messages.stream(…)` + `finalMessage()` returns the same
  `Message`, so the loop is otherwise untouched. It survived 489 green tests
  because `test/ai-agent.test.ts` stubbed `create` with a bare `vi.fn()`, which
  accepts what the real client refuses — a mock more permissive than the thing
  it stands in for tests the mock. It reproduces the guard now. **And there are
  two cache breakpoints**: the explicit one on the system prompt (which covers
  the tools with it — they sort ahead of system in the prefix), plus the
  top-level `cache_control` field for the growing conversation tail, which
  carries the whole of the model's research over up to 40 turns and was being
  re-sent at full price every one of them.

- **The AI cache is a library now, and a rejection is a step.** `ai_mappings`
  has always made the second device of a model free; what was missing was any
  way to see it, carry it to another hub, or fix an entry that was nearly
  right. `src/ai/library.ts` adds five routes, and only `repair` needs a
  credential — listing, downloading, uploading and deleting are local
  operations on stored JSON, and gating them on a key would be the same mistake
  as gating the static mapper on one. Three rules: the download is an
  **envelope**, because a bare descriptor does not say which device it is for,
  and the upload accepts either; a mismatched `exposesHash` is **accepted and
  flagged**, since a mapping from a neighbouring firmware revision is the case
  this exists for; and a refused document is a **422 with the reasons and is
  kept**, because "invalid, try again" is a dead end for somebody who cannot
  read a zod issue path — `repair` hands the draft and the complaints back to
  the agent, bypassing the cache, since a `rejected` row is exactly what it is
  fixing. `exposesHash` lives with the exposes mapper, not with the AI: it is a
  property of the device's published schema, and the adapter records it in
  `DeviceRecognition` without importing the AI stack.
  **Forgetting an entry is not applying one, and using the same call for both
  bought a replacement for the mapping you were deleting.** `applyStoredMapping`
  re-adopts with `consultMapping: true`, which is right after an upload or a
  repair — there is something in the library to consult, the cache hits, no run
  happens. `remove()` called it too, against a hash it had *just deleted*: the
  lookup missed and the mapper started a fresh paid run, awaited, minutes long,
  inside a request Studio abandons after ten seconds — surfacing as "Studio
  couldn't remove that schema. The request timed out." The timeout was the
  smaller half; pressing **Forget** spending money on a new mapping is the
  opposite of what the button says. `forgetStoredMapping` asks for nothing, and
  needs **two** suppressions rather than one, because either alone is a no-op:
  `adoptDevice` deliberately carries a previous mapping over (so a regeneration
  never leaves a device less usable mid-run), and `needsHelp` is true for any
  device with an uncovered property — which is most devices an AI mapping was
  ever made for. The device falls back to its static mapping, which is what the
  three layers are for, and the next *genuine* trigger asks.
- **Trying again is the whole recovery path, and three things used to break
  it.** Recognition fails for reasons a person can fix — a key that is wrong, a
  key that names no workspace, a model too weak to submit a valid descriptor —
  and every one of those fixes ends the same way: come back and press *Work it
  out again*. **First, `POST /devices/:id/remap` answers as soon as the run is
  under way**, never when it ends. It used to await the whole run, against a
  ten-minute watchdog and a Studio client whose HTTP timeout is ten seconds, so
  the button reported a failure on every retry that actually did any work and
  appeared to succeed only on runs that failed instantly. `ZigbeeAdapter.remap`
  is fire-and-forget now, the shape `scheduleParameterRemap` beside it always
  had; `false` still means the radio has no published schema for that device
  *now*, which is the only answer available without waiting. **Second, the
  backoff gate names the credential it was armed against** and retires itself
  when the provider, the model or the key moves — otherwise the judgement "this
  account is unavailable" outlived the account, and a hub-wide gate armed by one
  provider silenced the other, which is exactly the switch an app tells somebody
  to reach for. Keying it on `provider:model:sha256(secret)` means no channel
  from the settings routes to keep in step. **Third, an explicit run ignores the
  gate entirely**, the stance `MappingLibrary.repair` already took by building
  its own mapper — and the flag travels to the check rather than being settled
  where the button is pressed, because runs are serialized hub-wide and a run
  already queued can arm the gate in between. `test/ai-retry.test.ts` pins all
  of it.
  **And a failed run is recorded in words, not in a response body.** This is
  `diagnosis.ts`'s rule one module over: an SDK error's `message` is the status
  with the whole JSON body glued to it, so a device row in Studio read
  `400 {"type":"error","error":{…}}` with the one useful sentence in the middle
  of it. `describeRunFailure` digs that sentence out and, for a refusal that is
  really a *setting*, adds the fix and records `config` — today the one entry is
  an identity-linked Anthropic key, which must name a workspace on every request
  and which the hub deliberately does not choose for anybody. Same three rules
  as the Zigbee diagnosis: most-specific-first, an unrecognised failure is still
  reported with nothing guessed about it, and nothing throws — it runs inside
  the catch of a run that has already failed.
- **What a run *said* can be kept, and the switch is the whole reason that is
  affordable.** `ai_runs` is a summary by design — model prose on an SD card is
  the write amplification the rest of the store is arranged to avoid — and
  `ai_run_exchanges` is the one deliberate exception, because a refusal is
  often about the *request*: a model that will not take a parameter, a key that
  names no workspace, and the run log's one sentence cannot answer "what did we
  actually send?". **A run is a loop, not a request** — up to `AGENT_MAX_TURNS`
  (40) rounds against the provider — so a failed round followed by a successful
  one is the ordinary shape of a working run, and anything recording what was
  said has to record it per round, with the provider and the model on each
  (a run can be retried against the other vendor entirely). Six rules.
  **Off costs nothing**: the switch *is* the presence of
  `AgentRunContext.onExchange`, not a flag a handler reads, so a run nobody
  asked about never walks a content block — the `MqttObserver` stance.
  **A round records what it added, never the conversation so far**: an agent
  loop resends everything every turn, and the system prompt and the
  `submit_mapping` schema alone are 9.9 KB and 6.7 KB *per round*, so recording
  each request whole would write them forty times and make the last round the
  size of the run; the configuration and the system prompt are carried once, on
  round 1. **It is main data, not bodies** — labelled, excerpted parts
  (`{kind, label, text?, bytes?}`), with `kind` an open string like
  `commandFailed.kind`, and a cut part carrying what it weighed whole so no app
  asserts a constant from here. **Nothing carries a credential**: request
  bodies only, never headers. **It can never end a run** — recognising the
  device is the job and this is a convenience, so the distillation, the
  excerpting and the callback all sit under one `catch` inside `record()`,
  which is why it takes a thunk rather than a value. And **two bounds**, seven
  days and a row cap, written once with the run rather than per round
  (`STATE_FLUSH_MS` again), with a pruned run taking its rounds with it.
  `docs/ai-adaptation.md` is canonical.
- **A device is routable before the agent is asked, a new parameter is not a
  reason to pay again, and the overlay may not take a capability away.** Five
  faults met on one Aqara plug, and they read as one symptom — a plug that had
  worked until the AI mapped it, then sat dead while its model was recognised
  over and over. **First, `adoptDevice` put the device into `byIeee`/`byFriendlyName`
  *after* awaiting the mapper.** Those two maps are how `handleMessage` finds a
  device, so for the tens of seconds a run takes every state report and every
  `<name>/availability` message was looked up, missed and dropped — and on the
  first adoption after a restart there is no earlier entry at all, which is
  exactly when Z2M republishes its retained availability. The hub threw away
  the one message saying the device was back and kept the `offline` it had read
  out of SQLite. Registering first costs nothing and is what makes a run
  invisible to the rest of the adapter; the previous mapping is carried over
  too, so a regeneration never leaves a device less usable than it was.
  **Second, the runtime unknown-key remap forced a regeneration**, which drops
  the stored mapping and pays for a fresh run — so a model already recognised
  was recognised again every time one more property appeared, and `aiAskedKeys`
  is in-memory, so every restart began the sequence again. Four paid runs on
  one plug in an hour, each mapping covering whichever properties were in that
  run's samples. It consults the library now: a model this hub knows costs
  nothing to meet again, and *upgrading* one is what the owner's "Work it out
  again" is for — the only thing that should spend money unasked.
  **Third, `version` was `z.literal(1)` rather than defaulted**, so a run would
  submit a good descriptor, be told `version: Invalid input: expected 1`, and
  resubmit — five, six, seven paid rounds of one run, on every run. It is a
  constant; the parse fills it in.
  **Fourth, `mergedEndpoints` let the descriptor overwrite `primary`**, and
  that is the one that actually looked like a broken device. Capabilities merge
  as a union, so the overlay can only add — but `primary` is a single field,
  it is what every app draws the tile from, and `custom` is layer 2's generic
  catch-all, which renders as *no control at all*. A mapping that named
  `custom` as its primary therefore turned a working switch into a dead grey
  tile while the hub reported the device perfectly online and `onOff` sat in
  `capabilities` untouched: nothing but that one word had moved, which is why
  every reachability theory came back clean. The agent's `primary` is taken
  only when it neither demotes a typed capability to `custom` nor names a
  capability the merged endpoint does not have — a primary with no state behind
  it is a tile bound to nothing. Promotion is untouched, because a `custom`
  primary upgraded to `onOff` is the whole point of layer 3; it is only the
  demotion that is refused. The general rule is worth more than the case:
  **an AI overlay may add to what the static mapper found and may never
  subtract from it**, so anything new that merges a descriptor into a static
  mapping has to say what happens to the fields that cannot be unioned.
  **And the merge that combines the two *reports* was breaking that rule too,
  one recursion short.** `handleMessage` runs the static rules and the
  overlay's rules over the same payload and merges the patches, and the
  adapter had a private one-level-deep merge for it — right for every shape in
  `EndpointState` except the one that is two levels deep, `custom.values`. So
  the moment an overlay declared a generic field of its own, its `values`
  object replaced the static mapper's wholesale: the inventory went on
  advertising every static field and not one of them received another value.
  Seen on an Aqara plug whose six settings went blank behind an uploaded
  schema naming three fields, which reads as controls the plug had stopped
  answering. `schema/state.ts` already had the recursive version, with a
  comment naming `custom.values` as the case to get right — which is exactly
  why there should only ever have been one of them, and there is now:
  `mergeStatePatch`, beside `mergeState`.
  **The whole of this bullet is about a device layers 1–2 place completely,
  and the prompt had no way to say so.** `uncovered` is empty for that plug,
  so the agent has genuinely nothing to do — but `submit_mapping` is the only
  answer channel and the schema needs an endpoint, so a model with nothing to
  add invents something. Both vendors did, in the two ways available:
  restating the generic fields that already existed (a harmless no-op), and
  declaring fields for properties `IGNORED_PROPERTIES` hides plus one the
  device does not publish at all. Two additions to `prompts.ts` close it, and both are
  about the message being **true** rather than about steering the model. One
  sentence says that a property appearing in none of the three lists is
  telemetry the static mapper hides on purpose — without that, `uncovered: []`
  reads as "nothing here needs looking at" while the exposes tree plainly
  carries properties nothing has placed. And when `uncovered` is empty **and
  layers 1–2 placed something**, it asks for a genuine *upgrade* or for the
  hub's own mapping back unchanged. That second condition is load-bearing and was missed
  once: a device whose exposes are all on the hidden list places into
  *nothing* — one endpoint, no capabilities — with `uncovered` still empty
  because nothing was left over to be uncovered, which is the case with the
  **most** work in it and the one `needsHelp`'s `staticallyEmpty` arm exists
  for.
  **What that sentence must not become is a list**, and it took two goes to
  land. The first version named the hidden properties per device and said
  never to re-declare them — which would have refused the one genuinely useful
  thing either run did for that plug, since the list is applied without
  knowing the device and cannot tell mains voltage on a metered plug from
  battery voltage on a door sensor. The second kept the list and softened it
  to a judgement, which was right and still more than the hub has any business
  saying: the fact only the hub holds is that the absence is deliberate, and
  the decision belongs to the layer that can see the device. Neither addition
  is a filter in code —
  dropping a field for an unpublished property would break
  `detectUnknownParameters`, which exists precisely because devices publish
  keys their exposes tree never declared.
  **Fifth, the radio's word on a device can arrive before the device has a
  name** — found in the same hub's log, and the one that fails in the opposite
  direction. The broker replays every retained message the instant the adapter
  subscribes, so `bridge/devices` — the only thing that *names* a device — and
  the `<name>/availability` readings about those devices land in one burst, in
  whatever order the broker picks. `bridge/devices` is dispatched as
  `void syncDevices(...)` and `syncDevices` awaits `adoptDevice` per device, so
  only the **first** device is registered synchronously: every device behind it
  is still nameless when its own retained availability is handled, the
  `byFriendlyName` lookup misses, and Zigbee2MQTT's own account of what it can
  reach is dropped on the floor — on every start, for every device but one.
  What was left was `bridge/state`, which says only "the radio is up" and marks
  *everything* online, so a device that was genuinely away came back reading
  healthy and stayed that way; for a device that is simply gone there is no
  later change to publish, because the retained message was the whole
  statement. An unrecognised name is parked in `pendingAvailability` and
  replayed the moment `adoptDevice` registers it, bounded (one entry per name,
  oldest evicted past the cap) since it is fed by whatever sits on the broker's
  tree rather than by anything the hub knows. Note the direction before
  reaching for this to explain a device stuck offline: it made devices falsely
  **online**, never falsely offline.

- **The automation agent is authoring, never runtime, and it lives on the
  hub.** `src/ai/automation-*.ts` writes rules in conversation;
  `src/automations/` runs them, with no key, no network and no idea the agent
  exists. So `ai_enabled: false` stops rules being *written* and touches
  nothing already running — "stop spending my money on this for now" must not
  put the lights out on a schedule. `docs/automations.md` is canonical.
  On the hub for the same reason the mapper is (the Agent SDK's 276 MB binary
  and per-run subprocess), and **not in the cloud** for a reason of its own:
  this agent's tools *are* the home, the home is on a local network, and a
  provider's container cannot reach it — every tool call would need a tunnel
  that does not exist.
  **A conversation suspends, which is what makes it different from a mapping
  run.** That run is one call that either submits a descriptor or does not;
  this one hands control back on `ask_user` **and** on a prose ending, both of
  which outlive the request. So the provider owns the message history (it is
  the vendor's own shape) and the conversation is an object with a lifetime.
  Answering closes the tool call `ask_user` opened — a plain user message after
  a pending call is a conversation the API refuses — which is why `answer()`
  sits beside `send()` and why a *typed* reply is routed to `answer` anyway.
  **Two stores, and the split is what makes keeping a chat affordable.** The
  message history is in memory, tens of kilobytes a round, and dies with the
  process; the transcript an app draws is on disk, a few hundred bytes a
  message.
  **The memory is rebuilt from the record, and it has to be, because the two
  lifetimes are two hours and a fortnight.** A restart or the idle sweep used
  to cost the *continuation* — `410 conversation_ended`, the chat readable and
  nothing more — which sounded like an edge and was the ordinary case: for
  thirteen of every fourteen days everything in the conversations list answered
  410, both apps drew a closed composer over it, and "ask it to try again" was
  not a thing anybody could do about a conversation that had worked perfectly.
  `revive()` builds a fresh provider conversation under the same session id and
  primes it with a recap of the stored rows. Three rules. The recap reaches the
  **model and never the transcript** — it is a read-back of rows that are
  already there, and writing it down would put the chat inside itself as a
  message — so it rides on `ChatSession.priming`, consumed by the first
  exchange. It is worded as *history rather than memory*, because a model told
  it remembers a decision it is only reading will defend it. And **ownership is
  read back out of the rows** (`automation_chat_messages.member_id`): a live
  session carries its member and `reply` compares against it, while a revived
  one is built from the caller's own id, so without that any member could
  reopen anybody's conversation by its id. The only `410` left is a session
  with no rows at all — one that never existed, or whose fortnight is up. **`ask_user` carries two to four options** because somebody who does
  not write software taps one and will not compose an answer, and that is the
  single thing that makes this usable by the people it is for.
  **Prose *is* an answer, and saying otherwise cost a rule.** The prompt read
  "a run that ends without submitting has produced nothing" and
  `submit_automation`'s description said the same, so asked "how does this
  work?" the model reasoned — visibly, in the trail — that "the framework seems
  to require submitting something to produce output" and resubmitted the rule
  unchanged: it rewrote what the home was running to answer a question about it,
  and handed back a card with nothing said. Both now say the true thing —
  submitting is the only way to *deliver a rule*, prose reaches the person
  exactly as written, and a rule is never resubmitted unchanged.
  **A step says what it did, not only what it was**: `AutomationToolResult`
  carries an optional `detail` beside the `text` the model reads (the device
  looked at, how many matched, the sentence a draft would carry, the first
  reason it would be refused), and it rides the same `step` frame `ask_user`'s
  question does — `dry_run`'s is the most useful line in the trail, the rule read
  out while the agent is still deciding rather than only on the card afterwards.
  **One conversation, any number of rules — and one reply can carry more than
  one card.** Two faults, and they read as one: the loop kept a single
  `handedBack`, so a second `submit_automation` in one response overwrote the
  first (both told "Accepted", one ever saved); and the save was positional —
  first submission creates, every one after it *replaces* — which was right
  about a model fixing the rule it had just written and silently wrong about
  "and also switch everything off at midnight", which overwrote what had been
  written a minute earlier. So a turn hands back a **list**, and each
  submission says which rule it is: `replaces` is an id or `null`, **required
  and nullable** rather than optional, because an omitted id is exactly the
  ambiguity that caused the bug and only the model can resolve it. The ids
  reach it on `ChatSession.priming` — the `revive()` channel, model-only,
  never a transcript row — since a rule written a minute ago has an id the
  model has never seen; a revived conversation's recap carries a preview row's
  id for the same reason. One row per rule (so an app draws a card each, with
  `edited` per rule), and the prompt asks for **one line for the lot** rather
  than a paragraph per card. Bounded at four rules a response
  (`AUTOMATION_MAX_RULES_PER_TURN`): two is the case this exists for, and past
  four it is a model that has misread the room writing a page of rules into
  somebody's home — the accepted ones are saved and the rest refused inside the
  turn, to be offered once the person has replied.
  **A submission writes the model's line and then the card, and asking for
  that line one round too late is why it was blank.** The card carries
  `describeAutomation`'s sentence — the *rule*, the same words for everybody —
  while the line above it answers what was actually asked: what changed, in
  their language. On an edit the card alone never says whether it was done.
  The instruction to write it sat in `submit_automation`'s own result ("tell
  them what it will do, briefly, and stop"), which the model can never act on,
  since accepting a submission *ends the turn* and that result is read only on
  the next one — where it is stale advice about last time's rule; and the
  prompt paragraph above it read "prose is not an answer", true about
  delivering a rule and read as "do not write any". The prompt asks for it in
  the **same message as the call** now. Neither the hub nor an app writes that
  line: a canned "All done" is words in the model's mouth. **And when the model
  forgets anyway the loop sends the submission back for it — once**: an accepted
  rule with no prose is held rather than returned, the results go back, and one
  more round runs purely for the sentence (its own step, since the person is
  watching it). Exactly one, because the rule is already saved and a third round
  spent on a sentence the model will not write is worse than handing the card
  over without one.
  **The prompt says what the prose is written *into*.** A model writes Markdown,
  and both halves of that were missing: the apps drew it as characters and the
  prompt never described the surface, so an answer listing four rules arrived
  with `**a bolded heading:**` over a column of literal hyphens. The app renders
  it now (`AgentProse`), and the prompt names the column — three inches wide,
  short paragraphs, a list where something is genuinely listed, bold for a name
  worth picking out — with headings, tables, nested lists and code fences called
  out as not what it is for. Either half alone is worth little: rendering
  Markdown nobody was told to keep simple gives a typeset document in a chat
  bubble, and asking for restraint without rendering still shows the asterisks.
  **Seven tools and no web.** An agent writing a rule for a house has nothing
  to look up, and leaving search out is a plainer promise than a paragraph
  telling it not to search — the one AI surface here that reaches the
  provider's API and nothing else. `submit_automation` is the only answer
  channel and a refusal is a `tool_result` rather than the end of the
  conversation, so the model fixes its document and resubmits without the
  person seeing it got it wrong; `dry_run` is the agent checking its own work
  against the same rules, and it hands back the sentence the apps will show.
  The prompt is built from `catalogAsPrompt()`, names the refusals rather than
  begging for care (the guards are enforced, and a prompt implying otherwise
  reads as the only thing between somebody and a burnt-out relay), and says
  plainly that **there are no notifications** — a model that does not know
  that invents a notify action and spends a round finding out while somebody
  watches. `ai_runs` rows with `kind: 'automate'`, because what a home spent on
  AI is one question and two tables would make it two screens.
  **What a conversation cost is answerable, and three rules make it so.**
  `ai_runs.session_id` is the link: `automation_id` is null for a chat that
  submitted nothing and a revived one writes a row per incarnation, so nothing
  else could total them. **Each row is a delta, never a running total** — one
  is written at the end of **every turn**, so a chat writes several and summing
  totals would report far more than it cost; `record` was once-only for a
  while, which simply dropped everything after the first rule.
  **A turn is what spends, so a turn is what is written down** (`ChatRuntime.
  bank`), and that was learned the expensive way. The row used to wait for a
  *delivery* — a rule submitted, a job handed over — and otherwise for the idle
  sweep two hours later; the assistant delivers nothing at all, it answers a
  question or switches a lamp on, so the whole price of a conversation sat in
  memory and a hub restart took it with it. Every price in both apps
  disappeared at once after an update, which is how it was found. The sweep is
  only reached from `start` besides, so a home that stops beginning
  conversations never records the ones it had. The row is **awaited before the
  `turn` frame** so an app that re-reads the moment it is told to finds the
  round it just watched, and swallowed if it fails, because bookkeeping must
  not be what ends a turn. `RETAIN_RUNS` moved 60 → 250 with it: sixty was
  chosen when a run was a *job*, and per turn it had become about ten
  conversations against a fortnight of transcript they are meant to price.
  **A live conversation's unwritten remainder is still added** where
  `GET /automations/chats` answers, because the round *now running* has spent
  money no row has yet. And **the model is read back, never re-derived**:
  `effectiveModel` answers "what will *run*" and is meant to move with the
  offered list, which is precisely wrong for a record of a run that already
  happened — so `provider`/`modelId` are the columns verbatim and only the
  label goes through `modelLabel`, which falls back to the raw id once a model
  is retired. Absent rather than zero when the ledger no longer has it: sixty
  runs against a fortnight of transcript means a readable chat can outlive its
  own spend row, and `$0.00` is a claim where nothing is the truth.
  **The agent picks its own provider, and it is deliberately not the
  mapper's.** `ai.provider` answers "which model reads a device's exposes
  tree" — a real choice, because both halves of *that* are written. Only one
  half of this one is, so reading the same field turned an unrelated preference
  into a refusal: a home with both keys that recognised devices with OpenAI
  could not write a rule at all, with a perfectly good Anthropic key sitting
  beside it. It runs on Anthropic whenever the home has a key that can, and a
  legacy subscription token is not one, since the loop authenticates with
  `x-api-key`.
  **Every way this can be refused is an `AutomationNotConfiguredError` with a
  code *and* a sentence**, and that is the whole of a real bug: the OpenAI case
  threw an `AiUnavailableError` past the route's refusal handler, Fastify
  answered `{"statusCode":500,…}`, and the app drew "The hub answered 500."
  over a hub that was working perfectly and had just said what was wrong.
  Three codes, because they lead to three different screens — no key, AI
  switched off, a key of the wrong kind — with `detail` riding along so an app
  that has never met a code a later build adds still shows something true.
  **A spinner is not an answer to "what is happening", so the socket carries
  four phases.** `step` is one line per thing the agent did, `thinking` is its
  own summarized reasoning as it arrives, `delta` is the reply, `turn` says the
  transcript is ready. Steps used to be reported only once something had
  *happened* — and the first thing that happens in a round is none of it, so the
  longest wait in every round was three animated dots. A step now goes up
  **before** the request, and the reasoning is streamed, which only works
  because the loop asks for `display: 'summarized'` (this model's default
  streams thinking blocks empty). `kind` is what an app draws a mark from and is
  about the *shape of the act* rather than the tool — three tools all mean
  "reading your home" — so a new tool needs no app release; it is an open
  string, the `commandFailed.kind` rule.
  **And the working outlives the wait**: the round's steps are written into the
  **first row that round records** (`data.steps`, the frame's own three fields
  so the live trail and the stored one cannot drift), whichever kind of row it
  is — prose, a question, a card, or the note saying the model could not be
  reached, which is the ending with the most to explain. They were a stream and
  nothing else, gone the moment the turn landed, which is right about a dozen
  open rows above every answer and wrong about the *fact* that there were a
  dozen: a rule arrives out of a handful of tool calls and the page whose job
  is explaining a house to somebody who does not write software was left with
  the conclusion alone. Five bounds hold it to the size of a transcript row —
  the round's first row rather than each of them, the buffer cleared when a
  round **begins** so a throw cannot hand its working to the next answer, the
  person's own row never taking them, and **the last twelve** steps with text
  and detail **cut rather than dropped** (twelve covers every round this agent
  runs; the *last* twelve is the direction an app's live trail drops from, so
  what was watched is a suffix of what is read back). The sentences live in
  `automation-tools.ts` beside the tools: `Looked up list_rooms_zones.` is a
  function signature read out loud, on the one screen whose whole job is telling
  somebody who does not write software what their house is doing.
  **And two things a round produced were streamed and then dropped, so the trail
  somebody read back was a thinner thing than the one they watched.** The model's
  **reasoning** arrives between one step and the next, which makes it the working
  of the step already on screen; it is hung on that step's `detail` when the next
  step lands, when prose is said, or when the reply starts — the last because a
  round can end without another step. Only into an empty slot: a tool's own
  `detail` is the better sentence wherever there is one. And **prose from a round
  that then calls a tool is not the answer** — a model narrates ("I'll set that
  up for you.") and then calls something, and only the *last* round's text
  becomes a row — so it is kept as a step of its own, `kind: 'said'`, reported
  from `streamTurn` where both agents share it. That kind is the one the socket
  **never sends**: the words already reached the app as deltas, and a frame would
  draw the same sentence twice. Both are why `clip()` exists: `slice` was fine
  while these fields held the hub's own fixed sentences and cuts model-written
  prose mid-word, so it cuts at a word, appends an ellipsis, and counts the
  ellipsis against the bound.
  **Nothing is ever sent with a `tool_use` left unanswered, and the repair
  belongs before the next *user* turn.** Every call in an assistant turn needs
  a result in the very next message, and a conversation that breaks that rule
  is refused outright and for ever — `messages.N: tool_use ids were found
  without tool_result blocks`. The assistant turn is pushed the moment it
  arrives, so any exit between that push and the results leaves a dangling
  call: a `refusal`, a `pause_turn` carrying calls (now answered rather than
  skipped past), and above all *anything that throws* — `evaluateSubmission`
  reads the home outside `runAutomationTool`'s own catch, and `exchange`
  swallows the throw, writes a note and leaves the conversation open, so the
  damage is invisible until the next message is refused along with every one
  after it. `settleDanglingCalls()` closes them with `is_error` results, and it
  sits in `send()` before the user turn is pushed rather than beside the
  request, which is where it was first put and where it can never fire: mid-loop
  the last message is always the results of the round before.
  **`ask_user` hands back mid-response, and every *other* call in that response
  still has to be closed.** The API's rule is per response — each `tool_use` in
  an assistant turn needs a `tool_result` in the very next message — and handing
  the question back used to abandon the rest (calls before it collected and
  dropped, calls after it never run), so the next request carried a
  half-answered turn and the conversation was refused outright with `400
  tool_use ids were found without tool_result blocks`, reaching the chat as a
  wall of JSON where the answer belonged. They are stashed and sent with the
  answer; a second question in one response is refused inside the turn rather
  than left open, since only one call id can be closed by an answer.
  **A transcript nothing can find again is a transcript thrown away**, which is
  what `GET /automations/chats` exists for: the fourteen-day record was
  unreachable the moment a page closed, because the only way back was a session
  id nobody writes down. Its `title` is the first thing the *person* said (the
  agent's opening line is about the home, not about the ask) and `live` says
  whether it can be *continued* as against merely read — two different states,
  and an app has to offer the right one rather than find out on the next
  message.
  **A message is acknowledged, never awaited.** `POST /automations/chat` and
  `…/messages` answer the moment the hub takes the message — the person's own
  row and nothing else — because a turn is a provider loop with a three-minute
  watchdog and the iOS client gives a hub ten seconds. This is the
  `POST /devices/:id/remap` lesson, and this route shipped with the very bug
  that one was written to avoid: a conversation working perfectly reported
  "the request timed out" every time, while the reply it went on to produce
  arrived on a socket nobody was waiting on. Turns are **chained per
  conversation** (two exchanges against one provider history would interleave
  the messages array, and chaining is also what makes `awaitingAnswer()` get
  asked when a turn *begins* rather than when it was queued), and **every turn
  emits a `turn` frame, the failed ones included** — that frame is what says
  the transcript is ready to re-read and what takes an app's "thinking"
  indicator down, so the provider-failure path returning without one left a
  failed round spinning for ever over a note nothing had gone back for.
  **The test seam (`createConversation`) therefore sits *after* every
  configuration check.** It stands in for the network, not for the rules: above
  them it was a bypass, letting the suite reach a conversation the real hub
  would have refused — the "a mock laxer than the thing it stands in for tests
  the mock" trap, and exactly why the refusal shipped untested.
- **There are two conversational agents now, and one runtime under both.**
  `docs/assistant.md` is canonical. The assistant (`src/ai/assistant-*.ts`) is
  the one behind the app's assistant button: it answers about the home and the
  app, works devices, presses scenes — and **hands automation work to the
  automations agent** rather than learning the DSL.
  **`ChatRuntime` (`src/ai/chat/chat-runtime.ts`) is everything that is not
  about which agent is talking**, extracted from `AutomationChat` rather than
  copied out of it: sessions with a lifetime, the memory rebuilt from the
  transcript, the four socket phases, the step capture, the spend deltas, the
  retention, the list. A subclass supplies which model and prompt open a
  conversation and what to write down for the arms only it has; the three arms
  *every* agent has are the runtime's, so a new agent cannot get them subtly
  different. `chat/agent-loop.ts` is the same argument for the parts that are
  the **API's** shape — the two cache breakpoints, `display: 'summarized'`, the
  abort that becomes a sentence, and `QuestionGate`, which is the rule that no
  request may carry a `tool_use` with no `tool_result` after it. Each agent
  keeps its own `pump`, because what *ends* a turn genuinely differs.
  **One transcript store**, told apart by a nullable `surface` column on
  `automation_chat_messages` (null = `automation`, which every row written
  before it is). Two tables would be a second retention sweep, a second recap
  and a second step capture — and the second copy is where the bug lives. The
  rollback cost is named rather than discovered: an older build ignores the
  column and would list assistant chats among the automations ones, which is a
  confusing row on a build that has already failed its health check.
  **The handoff is the design, and it is three rules.** The *brief* is the whole
  interface — a self-contained task in the person's language, and the only
  thing that crosses — so the assistant never receives the other agent's tool
  calls, reasoning or transcript, which is what keeps its context the size of a
  conversation however many agents there come to be. And it is
  **acknowledged, never awaited**: `delegate` returns in milliseconds with the
  other agent's session id, the `POST /devices/:id/remap` lesson this
  repository has now paid for twice. What the app draws is a `handoff` row
  carrying that session id and nothing copied from it — the live trail, the
  questions and the rules are read from the sub-agent's own conversation, over
  the frames an app already draws. Its `status` moves as that agent's turns
  land, written by reading its transcript rather than by a second round with
  the model: the assistant is never re-entered for a job it has handed on —
  and said as **`amend` on the assistant's own session**, because the card is
  on that transcript and nothing here is a round ending. Both halves were
  wrong and each alone broke it: under the *delegated* session's id an app
  re-read the chat where nothing had changed and the card sat on "working"
  until the page was closed and reopened, and as `turn` it would have taken a
  live round's trail down with it whenever the other agent happened to move.
  **And a follow-up goes back to the conversation that did the work.** Every
  handover used to open a fresh one, so "now make it 11:30 instead" reached an
  agent that had never heard of the rule it had written five seconds earlier
  and paid to read the home again to find out what "it" was. `delegate` reads
  the last `handoff` row in *this* conversation for that agent and continues
  that session (`DelegateAgent.resume`, falling back to a fresh one for a
  session that can no longer be carried on). Continuing is the **default**,
  because the two failures are not the same size — no idea what is being
  talked about, against a little history nobody needed — and `fresh: true` is
  how the model says a job genuinely starts over. Read off the rows rather than
  remembered in a map, the `standingOf` rule; a second handover writes a second
  card and the **newest** one is the live one.
  **The registry is a table because of the third agent, not the second**
  (`src/ai/agents/registry.ts`): `delegate`'s description is *generated* from
  it, so adding an agent is one entry rather than a new tool, a new prompt
  paragraph and a release of both apps. `permission` is checked when the tool
  runs, so a member whose role cannot hand a job over gets a sentence the model
  reads out rather than a capability silently absent.
  **The agents' model list is its own** (`AGENT_MODELS` — Opus 5 and
  Sonnet 5), and the mapper's one-model list is untouched: a descriptor is
  cached against a device model and shapes every unit of it for ever, while a
  chat is many small rounds answered with another message when the reply is
  poor. **One list, a column each**: the assistant and the automations agent
  are offered the same two and choose independently
  (`ai_assistant_model`, `ai_automations_model`), because answering questions
  about the house and writing the rules it runs by itself are different jobs a
  home may want to spend differently on. The automations agent had no column of
  its own and read `ai_model` — the *mapper's* — which never showed, since that
  list offers one model and Sonnet is not on it, and was one added choice away
  from letting "which model recognises a device" decide "which model writes a
  rule". `effectiveAgentModel` is what **runs** as well as what is reported,
  which is the gap that cost the mapper a release. **And `modelLabel` reads
  both lists**, which is the same shape of gap from the other end: it names a
  model that has already run and searched the mapper's alone, so a chat on
  Sonnet 5 — offered here and nowhere else — reported `claude-sonnet-5` where a
  chat on Opus reported "Opus 5", and the apps drew a raw id over one
  conversation and a name over the next. One `ai_runs` table, two surfaces
  asking one question of it, so the answer is the union. Effort is `medium` here
  against the mapper's `high`, and is exposed by neither.
  **`control_device` is the one tool that writes to the home**, through the
  registry's ordinary path and into the activity log **named for the person who
  asked** — the feed is read a week later and "the assistant" is nobody anyone
  can go and ask. Bounded per *turn*, not as a guard against a person tapping
  quickly but against a model reading "everything off" as the whole house.
