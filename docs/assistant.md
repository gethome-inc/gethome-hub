# The assistant, and the agents it hands work to

Canonical for `src/ai/assistant-*.ts`, `src/ai/agents/` and `src/ai/chat/`.
[`docs/automations.md`](automations.md) is canonical for the agent that writes
rules; [`docs/api.md`](api.md) for the routes and the socket frames.

## What it is

One conversation, on the hub, behind the assistant button in the app. It
answers questions about the home and about the app, works devices and presses
scenes, says what it can and cannot do — and hands the jobs that belong to
another agent over to it.

It runs on **either vendor**, on a model the home chooses: **Opus 5** or
**Sonnet 5** on Anthropic, **GPT-5.6 Sol** or **GPT-5.6 Terra** on OpenAI. That
list is its own rather than the mapper's, and the difference is the trade: a
mapping descriptor is cached against a device *model* and shapes every unit of
it the home ever meets, so a cheaper tier that is wrong once is wrong for ever
and the mapper offers exactly one model per provider. A conversation is many
small rounds, read the moment they arrive and answered with another message
when the reply is poor — so what a round costs is a real choice somebody can
make, and both halves of it are visible.

**It was Anthropic-only, and not as a policy.** `chat/agent-loop.ts` typed every
signature against `Anthropic.*` and both agents imported the SDK at the top of
the file, so "the assistant runs on Claude" was a fact about the *module graph*
rather than about any setting — and `openConversation` refused outright when the
home had no Anthropic key, with a working OpenAI one beside it.
`ChatTransport` is what changed that: a `ChatRound` is `{said, calls, stop}`,
each vendor's shape lives behind one implementation of it, and
`createChatTransport` loads whichever half is needed, so a home with only an
OpenAI key never pulls the Anthropic client into its graph. That is
`agent-core.ts`'s rule, which the mapper has kept since it had two providers.

**The provider follows the model id**, and there is no second stored column —
ids do not collide across vendors, so one setting says both things and they can
never disagree. What is new beside it is that resolution is **key-aware**: a
home that has only ever had an OpenAI key still has `claude-opus-5` stored (it
is the default and nobody chose it), so a stored choice counts only while its
provider has a usable key, and otherwise falls back to the one that does. A
stored Claude *subscription token* is not a usable key — the loops authenticate
with an API key — and a home holding only that is the one case
`automation_needs_anthropic` is still for.

**Two lists per vendor means `modelLabel` has to read all of them**, and it did
not. It names a model that has already run — the label an app draws over a
finished conversation — and it searched the mapper's `PROVIDER_MODELS` alone.
Sonnet 5 is on the agents' list and nowhere else, so a chat that ran on it
reported `claude-sonnet-5` where a chat on Opus reported "Opus 5", and an app
drew a raw id at the top of one conversation and a name at the top of the next,
which reads as the app failing to translate rather than as the hub naming two
different things. Both surfaces record into one `ai_runs` table and both ask
this question of it, so the answer covers the union, per provider — leaving the
agents' list under `anthropic` alone would be the same gap pointed at the other
vendor.

## Two agents, one runtime

`ChatRuntime` (`src/ai/chat/chat-runtime.ts`) is everything about *having* a
conversation that is not about which agent is having it: sessions with a
lifetime, a memory rebuilt from the transcript when the hub has forgotten how
to continue one, the four socket phases, per-round step capture, spend recorded
as deltas into `ai_runs`, a fortnight's retention, and the list that makes a
conversation findable again.

**Spend is banked at the end of every turn**, and that is a rule rather than a
detail. The row used to wait for a *delivery* — a rule submitted, a job handed
over — and otherwise for the idle sweep two hours later. This agent delivers
nothing: it answers a question, or switches a lamp on. So the whole price of a
conversation sat in `ChatSession` memory, and a hub restart — an update, a
radio switch, a power cut — took it with it; after updating a hub, every price
in both apps was simply gone. `ChatRuntime.bank` writes it as each turn lands,
awaited before the `turn` frame so an app re-reading on that signal finds the
round it has just watched, and swallowed if the write fails, because
bookkeeping must not be what ends a turn.

It was all inside `AutomationChat`, and none of it was ever about automations.
A subclass supplies three things and nothing else: which model and prompt open
a conversation, what to write down for the turn arms only it can produce, and
which surface its rows belong to. The three arms **every** agent has — it said
something, it asked something, it ran out — are the runtime's, so a new agent
cannot get them subtly different.

`chat/agent-loop.ts` is the same argument one layer down — and it imports no
SDK. It holds the vocabulary a pump works in (`ChatRound`, `ChatToolCall`,
`ChatToolResult`, the four-word `ChatStop`) and `QuestionGate`, the rule that no
request may ever carry a tool call with no result after it. Each vendor's own
shape sits behind `ChatTransport`: `chat/anthropic-transport.ts` keeps the two
cache breakpoints, `display: 'summarized'` (the default is `omitted`, which
streams empty thinking blocks and reads as a silent minute) and the streamed
`messages.stream` that a non-streaming `create` would refuse outright;
`chat/openai-transport.ts` is the Responses API over plain `fetch` — no second
SDK for a Pi to download — with `summary: 'auto'` as that vendor's spelling of
the same lesson and `store: false` with the encrypted reasoning replayed by hand.
Every one of those was learned by breaking something; a second copy is a second
place to unlearn it.

`ChatStop` is worth its own line. Anthropic says
`end_turn`/`tool_use`/`refusal`/`pause_turn` and OpenAI answers a `status` with
a refusal block inside the output; both collapse to the same four questions —
did it finish, does it want tools, did it decline, should we ask again — and a
pump that branched on the raw value would be a pump per vendor.

**Reporting what a round said before it went off to work is there too**, for
the same reason: a model narrates and then calls something, only the last
round's text becomes a transcript row, and the loop is the one place that has
`said` and `calls` in hand at once. It goes into the round's working as a
`said` step rather than out as a frame — `docs/automations.md` has the whole of
it.

What each agent keeps is its own `pump`, because what ends a turn genuinely
differs: a rule for one, a handoff for the other.

## One transcript store

`automation_chat_messages` carries both, told apart by a nullable `surface`
column — null meaning `automation`, which is what every row written before the
column existed is. One store rather than two, because everything around a row
is worth writing once: the retention sweep, the recap, the step capture, the
`ai_runs` link.

The rollback cost is named rather than discovered. A build older than the
column ignores it, so a hub that has rolled back would list assistant
conversations among the automations ones and could revive one under the wrong
prompt. That is a confusing row on a build that has already failed its health
check, against a second copy of all of the above for ever.

Spend is one ledger: `ai_runs` rows with `kind: 'assist'`, linked by
`session_id`, beside the mapper's `map`/`repair` and the automations agent's
`automate`. What a home spent on AI is one question.

## The tools

Seven, and short on purpose. Three of them — `list_devices`, `get_device`,
`list_rooms_zones` — plus `get_automation` are the automations agent's own
handlers, *called* rather than re-implemented: they are pure functions over a
home view, and two answers to "what devices are there" is two answers to drift.

What is new is the pair the automations agent must never have.

**`control_device`** works the home. It goes through `DeviceRegistry.execute`,
the same path `POST /devices/:id/endpoints/:id/commands` takes — already
serialised per device, already the one place a command reaches an adapter — and
is written to the activity log as `device.command`, **named for the person who
asked**. That last part matters: the feed is read a week later, and "the
assistant" is not somebody anybody in the home can go and ask about it. `data`
carries `via: "assistant"` for an app that wants to draw the difference.

It is bounded at `ASSISTANT_MAX_COMMANDS_PER_TURN` (8) per *turn*. Not a guard
against a person — a person tapping quickly is a person, which is the whole
reason the automations engine's limits can be as tight as they are. This is a
guard against a misread: "turn everything off" understood as the whole house
when it meant the kitchen is a model's mistake landing on forty relays at once.

**`delegate`** is below. `run_automation` presses a rule somebody could press,
through the engine's own `runManually`. `ask_user` is the automations agent's
schema **verbatim**, so a question the assistant asks draws with the same
tappable options a rule-writing question does.

There is no web search, for the reason the automations agent has none: an
assistant for one house has nothing to look up, and leaving it out is a plainer
promise than a paragraph asking the model not to search.

## The handoff

The assistant does not write automations. It hands the job to the agent that
does, and three rules carry the whole design.

**The brief is the interface.** The assistant writes a self-contained task in
the person's own language and hands that over. It never receives the
sub-agent's tool calls, its reasoning or its transcript — only a status. That
is not a preference: it is what keeps this conversation's context the size of a
conversation however many agents there come to be, and it keeps the rules each
agent has to be told its own.

**It is acknowledged, never awaited.** `delegate` starts the other agent's
conversation and returns in milliseconds with its session id, so the model can
say what it did in the same breath. This is the `POST /devices/:id/remap`
lesson, which this repository has now paid for twice.

**And a follow-up goes back to the conversation that did the work.** Every
handover used to open a fresh one, so "now make it 11:30 instead" reached an
agent that had never heard of the rule it had written five seconds earlier —
and paid to read the home again to work out what "it" was. `delegate` reads
back the last `handoff` row in *this* conversation for that agent and continues
that session (`DelegateAgent.resume`, which revives from the transcript where
the memory has gone, and answers `false` for a session that can no longer be
carried on — then it starts fresh rather than failing). Continuing is the
**default**, because the two failures are not the same size: an agent given a
follow-up in a conversation it has never seen has no idea what is being talked
about, where an agent carrying a little history it does not need is merely
carrying it. `fresh: true` on the tool is how the model says a job genuinely
starts over. The session is read off the rows rather than remembered in a map —
the `standingOf` rule: the transcript is the truth about what was handed over,
and it survives a restart.

A second handover to the same conversation writes a **second card**, and the
newest one is the live one: `AssistantChat` tracks a delegated session by the
row it should amend, and the later row replaces the earlier. So the status
belongs to the card somebody is looking at rather than to the one that has
scrolled off the top, and an app draws the trail and the rules against the
newest card for a session — see the iOS side's `overtakenHandoffRows`.

What the app draws is a `handoff` row on the assistant's transcript:

```json
{ "agent": "automations", "title": "Automations agent",
  "brief": "switch the hall lamp on at sunset",
  "sessionId": "…the other agent's conversation…",
  "status": "working", "automationIds": [] }
```

`sessionId` is the whole of it. The live trail, the sub-agent's questions and
the rules it wrote are read from *that* conversation — the same
`GET /automations/chat/:id` and the same `automationChat` frames an app already
draws — so nothing is copied and there is no second shape to keep in step. A
question the sub-agent asks is answered against its own session, which is why
the person never has to leave the assistant to answer it.

`status` moves as that agent's turns land (`working` → `asked` → `delivered` /
`failed`), written by `AssistantChat` reading the sub-agent's transcript on its
`turn` frame — **never by a second round with the model**. The assistant is not
re-entered for a job it has already handed on. A conversation reopened next
week reads "delivered · 2 rules" rather than a spinner frozen mid-sentence.

**And it says so on the right conversation, as `amend`.** The card is on the
*assistant's* transcript, so that is the session id the frame carries — under
the delegated session's id an app dutifully re-read the chat where nothing had
changed, and the card sat on "working" until somebody closed the page and came
back. It is `amend` rather than `turn` because nothing here is a round ending:
this lands whenever the other agent moves, including mid-round in the
conversation it is about, and `turn` would have taken that round's trail down
with it. `docs/api.md` is canonical on the phase.

## The voice

The same assistant, reached by talking. **GPT-Live (`gpt-live-1`) is the voice
layer and nothing else** — it listens and speaks at once, so it can be
interrupted mid-sentence — and it delegates the thinking to a backend you
choose, which is exactly the split this hub already has: the brain stays here,
where the home is, on whatever model the home picked.

**`delegation.type: 'client'` is that architecture in one field**, and it is
the decision everything else on this surface follows from. GPT-Live offers two
modes. `responses` hands task reasoning to a model OpenAI hosts, configured
with its own instructions and its own tool list — which would quietly make the
home's model choice not apply the moment somebody started talking, and would
route every command around this hub's agent, its transcript and its handoff to
the rule writer. `client` asks *this hub* instead. So the home keeps all four.

**The cost of that choice is real and worth stating: client delegation makes no
structured tool calls.** `session.delegation.created` carries an id, a target
and a timing offset — no request text, no tool name, no parsed arguments — so
the voice has no catalog to declare and no fast path of its own. There *was*
one, for a few days: the phone proxied `control_device` and the read tools
through a `POST /assistant/voice/tool` route in one LAN hop, on the reasoning
that switching a lamp through a reasoning model is three seconds where it
should be a third of one. That route is gone, because the shape it was built on
does not exist in this API. What replaces it is not slow for the reason it
looks: the assistant's own `control_device` is an in-process call to the
registry that is already there, so a lamp is one model round rather than two
network hops — and the voice is told to say "one moment" and keep listening
while it happens, which the API is built for.

## The sideband, and where the loop belongs

**Somebody has to assemble the request, and for two days it was the phone.**
That is the shape client delegation forces: the notice says "I need help", the
transcript says what was asked, and the two have to be put together by whoever
is listening. Doing it on the phone meant every spoken request went OpenAI →
phone → hub → phone → OpenAI — two LAN legs added to the one thing on this
surface measured in how fast a lamp goes off, plus a transcript written by a
phone and a duration measured with a stopwatch on it.

A **sideband** is a second connection onto the *same* session, attached from
here at `wss://api.openai.com/v1/live/sessions/{id}/attach` with the home's own
key. `src/ai/voice/sideband.ts` is canonical. It receives every event the
phone's data channel receives and accepts every command, so the request never
leaves the machine that can answer it.

**The API's own rule is one owner per action**, because both connections see
everything — so the split is written down rather than left to whichever side
happens to react first. The sideband owns **delegations** (the phone answers
none), **the transcript** and **what the line cost**. The phone owns the
**audio** and the live captions on its page, and it is the phone that sends
`session.close`, because it is the thing somebody presses stop on.

**`askAloud` is the whole delegation handler, and it is ten lines** where the
phone's was sixty — because the wait is the runtime's own. The phone could only
acknowledge a message, subscribe to a socket, and resume a continuation when a
`turn` frame came back with the rows re-read; here the conversation's
`inFlight` is the answer. It runs the **ordinary** path, so a spoken exchange
leaves exactly the two rows a typed one does, with the same trail on the socket
and the same conversation to carry on by typing. That also fixed a real bug:
the phone wrote the person's sentence itself *and* sent it as a message, so
every spoken request landed in the transcript twice. Nothing writes rows now
but the round.

**One thing about attaching costs a Raspberry Pi something, and it is not
optional.** A sideband is sent *copies* of both directions of audio — base64
PCM16 at 24 kHz, about a megabit a second, several kilobytes of JSON every
twenty milliseconds — with no way to decline it. So `frameType` reads the type
off a **bounded prefix** of the raw frame and audio is dropped before anything
is parsed, with a full parse as the fallback for a frame whose `type` sits
past the prefix. JSON promises no field order; every frame this API actually
sends puts `type` first, and `test/voice-prompts.test.ts` pins both halves.

The registry of attached sidebands is **module-level rather than a service
threaded through `ApiDeps`**, and that is a trade rather than laziness: one hub
is one home and one process, so there is exactly one of these however it is
passed, and every field added to `ApiDeps` is a field two `buildServer` call
sites in `test/` have to learn about — which has already cost this repository a
CI failure that read as `list.map is not a function` a hundred lines from its
cause.

**The hub describes the session and the phone holds it**, and both halves of
that are deliberate. Audio has to go straight from the phone to OpenAI or it is
not a conversation — a hop through a Raspberry Pi on the way to the west coast
and back is latency nobody would tolerate, and a 1 GHz core has better things
to do than relay PCM. But the home's key must not leave the hub, which is the
rule portraits are drawn here for, and *what the model is told* is the home's
business.

**WebRTC is what makes that possible, and it is the API's own answer rather
than a preference.** Live has two transports: a primary WebSocket at
`wss://api.openai.com/v1/live/sessions`, authenticated with the **project API
key** and documented "for server-side audio integrations", and WebRTC,
documented for "browser and mobile applications". There is no ephemeral client
secret anywhere in the family — the thing Realtime had, and the thing this
route was first built around. So a phone cannot hold a Live WebSocket without
holding the home's key, and the alternatives were relaying PCM through a Pi or
putting a project key on every phone. Instead `POST /assistant/voice/session`
takes the phone's **SDP offer**, attaches the whole session, posts both with the
home's key and hands back the answer. The session itself is never sent to the
app, so a prompt change, a voice change or a configuration key this API grows
next month reaches the microphone with no app release — and the phone ends up
holding an audio connection it was never given a credential of any kind for,
which is a stronger containment than an expiring secret was.

It is the better transport by some distance too, which is a bonus rather than
the argument: a WebSocket carries 24 kHz PCM16 as base64 over TCP — about 64 kB
a second, with head-of-line blocking, retransmission instead of concealment and
no congestion control — where WebRTC carries Opus over SRTP at a twentieth of
that, with a jitter buffer, packet-loss concealment and congestion control, on
a path built for conversation. `audio.format` is deliberately **not** sent:
it is a WebSocket field and WebRTC refuses it, negotiating its own.

**The prompt is split the way OpenAI's own guides say to split it**, which
happens to be the split this hub already had. Conversation style and when to
ask for help go to the voice; business rules, tool workflows and the shape of
the home go to the backend — and the backend is the assistant, whose prompt
carries every one of them already. So `liveInstructions` is what is left after
that subtraction, **written to the prompting guide's own structure**, labels
included: a short personality, then `Backchannel policy`, `Interruption
policy`, and a `Delegation policy` split into *Backend tools*, *Delegate to the
backend when* and *Do not delegate to the backend when*. The guide asks for
those labels by name and for concrete conditions rather than "delegate when
needed", which is what makes the policy checkable against a handful of real
requests — and is how it should be revised when the voice turns out to delegate
too much or too little.

Two of the guide's *optional* controls are not optional here. A room is a noisy
place: a kitchen has a television in it, other people talking, and a kettle, so
"keep listening while they pause, and do not treat a television or a nearby
conversation as a new request" earns its place. Its sibling — ask about the part
you did not catch — earns it for the same reason, since the thing most often
misheard in this app is a room or device name.

What is left beside the policy is the home's **names**, and nothing else: a
device id, an endpoint number or a capability list is context a model with no
tools can only mispronounce. They are **bounded** (`NAME_LIMIT`), because the
live model's context window is small and a warehouse of eighty smart plugs must
not crowd out the policy above it. `test/voice-prompts.test.ts` pins the labels
and the bound, because the way this regresses is somebody flattening the policy
into prose or copying the assistant's prompt back in.

**It is the same transcript**, which is the part worth having. The rows are the
round's own, written here, so the page fills in while somebody talks, is there
when they open it afterwards, and can be *continued* by typing — `revive()`
rebuilds a model conversation from exactly those rows, so a typed follow-up
reaches an agent that has read what was spoken. It runs the other way too: when
the app sends a session id it already has, that conversation's last few
exchanges are seeded into `session.input`, so pressing the microphone on a page
you have been typing on carries one conversation on rather than starting a
second beside it. `beginVoice()` is still only an id and a mark: what it opens
is a conversation nothing has said anything in yet, which is why `askAloud`
reaches for `open()` — there is no transcript to revive from until the first
question arrives. That mark is what keeps **one word in the activity log** true: a command
somebody spoke and a command somebody typed are worth telling apart in a feed
read a week later, and since every spoken command now arrives as an ordinary
assistant turn, `spokenSessions` is the only thing left that knows which is
which. It is read at the moment of the command rather than closed over, because
one conversation can be typed in the morning and talked to in the evening.

**There is no turn-completed event**, so a transcript row is the client's to
assemble. `session.input_transcript.delta` and `session.output_transcript.delta`
carry fragments with `start_ms`/`end_ms` and no item id, both speakers can grow
at once, and a fragment is explicitly not a turn — so the app accumulates per
speaker and writes a row when that speaker has been quiet for a moment. The hub
takes finished rows only, which is the `STATE_FLUSH_MS` rule in another place: a
row per fragment would be a database write per syllable onto an SD card.

**Two meters, and pretending otherwise would hide one.** A voice session writes
its own `ai_runs` row (`kind: 'voice'`, $0.05 a minute) beside the `assist` rows
the delegated turns already write. GPT-Live bills for *time on the line* —
silence and backend thinking included — where the model behind it bills for
tokens; summed they are what the conversation cost, apart they answer why. The
seconds are the **session's own**, read off `session.usage.updated` and
`session.closed` on the sideband — which is what stopped them being the softest
number in this ledger. They used to be a stopwatch on a phone, gone entirely
when somebody force-quit; now a socket that drops before the final event
records the last snapshot it saw, which is the API's own advice, and a session
that never said anything records nothing rather than guessing.

**`live-wire.ts` is the containment, and it is a rule rather than tidiness.**
Every constant and every field name of an API weeks old lives in that one file,
mirrored by the app's own `LiveWire.swift`. It is the one thing here nobody can
check by running the suite — and it has been got wrong twice. First when
`Model "gpt-live-1" is not supported in realtime mode` was read as a wrong
model id rather than as the wrong *endpoint family*: the model was right and
everything around it was Realtime's. Then when the WebSocket was kept and a
client secret assumed to exist for it, because the pages describing the
transports had not been read yet — the containment is what made that a
constant and a route rather than a hunt. Read OpenAI's guides against those two
files before chasing anything else.

## The registry, and the third agent

`src/ai/agents/registry.ts` is a table with one entry today, and it is a table
because of the entries that are not there yet. With a tool per agent, a third
means a new tool, a new paragraph in the system prompt naming it, and a release
of both apps before anybody can reach it. With one `delegate` tool whose
description is **generated** from this table, a third agent is one entry — the
model is told about it in the same breath as the others, and no app changes.

An entry keeps three rules. `start` and `resume` are both required, because a
job and a follow-up to it are two different things and an agent that could only
be started can only ever be told something once. `description` is written for
the model and is the only thing it knows about that agent, so it says what the
agent is for *and* what it is not — the failure it prevents is a job handed to the wrong agent and
a person watching a rule being written when they asked a question. And
`permission` is checked **when the tool runs**, not when the prompt is built: a
member whose role cannot hand a job over gets a sentence the model reads out,
rather than a capability that is silently absent for reasons nobody explains.

## Refusals

**Two kinds, and they are not the same thing.** A *classifier* refusal is the
model declining a request, and it reaches a pump as `ChatStop: 'refusal'` —
HTTP 200 on both vendors, `stop_reason: "refusal"` with a `stop_details`
category on Anthropic, a `refusal` content block on OpenAI, which reports no
category at all and therefore always takes the generic sentence. It is a content outcome, not an error — code that
reads `content[0]` without checking the stop reason breaks on it, which is why
both pumps check first. `refusalSentence` (`chat/agent-loop.ts`) turns the
category into words: `reasoning_extraction` is somebody asking the assistant to
show its own thinking, and `cyber` fires on benign security work, which for a
hub means questions about its own network — the two a home can plausibly trip
and the two a generic "try asking differently" helps least with. **The stop
reason decides *that* it was refused and the category decides only the
sentence**: `stop_details` is informational, is `null` on plenty of real
refusals, and its `explanation` is not guaranteed present.

Server-side `fallbacks` — where the API re-runs a declined request on another
model inside the same call — is **deliberately not enabled.** It would recover
a refusal rather than relabel it, and Anthropic's guidance is to opt in by
default on Opus-5-class models. Two things argue the other way here. The
workload is domestic: this agent answers "is the kitchen light on" and writes
schedules, so the classifiers it could trip are close to never. And the
parameter is beta with a churn record — `fallback: {model, on_partial}` →
`fallbacks: [...]` → `fallbacks: "default"`, across three superseded beta
headers — while this is firmware on a board in somebody's house that updates on
its own schedule. Enabling it is a two-line change (`client.beta.messages.stream`,
`betas: ['server-side-fallback-2026-07-01']`, `fallbacks: 'default'`, and the
`Beta*` request types) and worth revisiting if refusals ever show up in the run
log.

The other three refusals are the automations agent's, carrying the same codes
because both apps already branch on them: `ai_not_configured`, `ai_disabled`,
`automation_needs_anthropic` — the last narrowed to what is still true of it, a
credential the hub holds and cannot use. Each carries a sentence, so an app that has never
met a code a later build adds still shows something true.

The test seam (`createConversation`) sits **after** every one of them. Above
them it is a bypass, letting a suite reach a conversation the real hub would
have refused — "a mock laxer than the thing it stands in for tests the mock",
which is exactly how the automations agent's own refusal shipped untested and
reached a phone as a 500.
