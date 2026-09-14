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

The same assistant, reached by talking. **The realtime model
(`gpt-realtime-2.1`) is the voice layer and nothing else** — it listens and
speaks at once, so it can be interrupted mid-sentence — and it delegates the
thinking to a backend you choose, which is exactly the split this hub already
has: the brain stays here, where the home is, on whatever model the home picked.

**Mind the two names.** *GPT-Live* is what OpenAI calls the full-duplex voice
experience in ChatGPT, and `gpt-live-1` is **not an API model id** — this file
said it was, and the first phone to dial the socket got `Model "gpt-live-1" is
not supported in realtime mode` straight back. The API's family is
`gpt-realtime-*`, and a session's transcription is a separate speech-to-text
model again (`gpt-4o-transcribe`), not the live model doing double duty. The
account's own `GET /v1/models` is the authority; `live-wire.ts` carries the
alternates.

**The hub builds the session and the phone holds it**, and both halves of that
are deliberate. Audio has to go straight from the phone to OpenAI or it is not
a conversation — a hop through a Raspberry Pi on the way to the west coast and
back is latency nobody would tolerate, and a 1 GHz core has better things to do
than relay PCM. But the home's key must not leave the hub, which is the rule
portraits are drawn here for, and *what the model is told* is the home's
business. So `POST /assistant/voice/session` assembles the whole thing —
instructions, tools, voice, formats — mints an ephemeral client secret against
it, and hands the phone an `ek_…` value that expires and is not a key.

**Two speeds, and the split is most of how it feels.** Anything that needs
working out goes to `ask_home`, which is a message in the assistant's own
conversation on this hub — so the model choice still governs every real
decision once somebody starts talking, and a handoff to the automations agent
happens exactly as it always did. Everything fast is the voice's own:
`control_device`, `run_automation` and the read tools, proxied through
`POST /assistant/voice/tool` in one LAN hop. Switching a lamp through a
reasoning model is three seconds where it should be a third of one, and the
prompt says so in as many words, because the failure worth designing against
here is not the model being wrong — it is the model being slow about something
it could have done itself.

The catalog is **generated from `assistantTools()`**, minus two. `ask_user` is
gone because *speaking* is how this one asks a question: a tool that suspends a
turn for tappable options is a page's idiom, and the person is standing in a
room. `delegate` is gone because the voice hands work to the assistant rather
than to sub-agents of its own — one route out, and the assistant's transcript
stays the record of what was asked for.

**It is the same transcript**, which is the part worth having. What was said
becomes rows through `POST /assistant/voice/said`, so the page fills in while
somebody talks, is there when they open it afterwards, and can be *continued*
by typing — `revive()` rebuilds a model conversation from exactly those rows, so
a typed follow-up reaches an agent that has read what was spoken. `beginVoice()`
is three lines for that reason: a spoken exchange has no provider conversation
on this hub, so there is no session object to hold, nothing in memory and
nothing to sweep — only an id and a transcript. It takes one back, too: the
app hands its current session id to `POST /assistant/voice/session` when it has
one, so stopping and restarting the microphone on a page carries the same
conversation on instead of starting a second one beside it.

**Two meters, and pretending otherwise would hide one.** A voice session writes
its own `ai_runs` row (`kind: 'voice'`, $0.11 a minute) beside the `assist` rows
the delegated turns already write. The voice layer bills for *audio* where the
model behind it bills for text tokens; summed they are what the conversation
cost, apart they answer why. The seconds are the **phone's** measurement, which
is softer than anything else in this ledger and is the only one available, since
the hub is not in the audio path.

**And the per-minute figure is a bound rather than a rate.** The realtime models
bill per audio token, split by direction — roughly $0.019 a minute heard against
$0.077 a minute spoken — and seconds-on-the-line cannot tell those apart, so
`LIVE_USD_PER_MINUTE` sits at the top of the band for the reason the portrait
ledger prices an unsplit input at the dearer rate. Silence still costs, since
the microphone streams throughout. The way to stop estimating is for the phone
to report the two durations it already counts; `live-wire.ts` says so. It is bounded at half an hour (the secret's own lifetime), and a session
that ends without the phone saying so records nothing rather than guessing.

**`live-wire.ts` is the containment, and it is a rule rather than tidiness.**
Every constant and every field name of an API weeks old lives in that one file,
mirrored by the app's own `LiveWire.swift`. It is the one thing here nobody can
check by running the suite, so a field that turns out different is one edit in
one place rather than a hunt through an audio pipeline. Read OpenAI's guides
before changing anything in it.

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
