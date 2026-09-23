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

Each row also says **what that turn ran at and how it was asked** — `effort`
(`low`/`medium`/`high`) beside `via` (`voice`/`typed`), filled from the turn's
own origin at the moment the round begins, the way `provider`/`modelId` are
read back rather than re-derived. Without them a spoken round and a typed one
on the same model were the same row twice at different prices, and the first
thing anybody asks about a poor answer is what was behind it. Both are
**nullable and null means the question does not apply**: a row written before
them has neither, a portrait has no effort, a device recognition nobody asked
for has no `via`, and the `voice` meter is a line rather than a generation, so
it carries `via: 'voice'` and no effort — GPT-Live has no such setting, and a
number invented here would be the one field in this log that was never true of
anything. They are two narrow columns rather than a `meta` blob because both
are closed vocabularies a screen groups and sums by; `ai_run_exchanges` is
where *content* goes, and its rule that request bodies are recorded and headers
never are is what keeps a run log safe to read.

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
while it happens, which the API is built for. And with a decision key stored there is a fast
path again, one layer further in and for typed and spoken turns alike: the hub
reads the delegated sentence before the assistant is asked and carries a plain
command out first, so what is left of the round is the sentence the voice reads
back (see *Deciding before the model is asked*).

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
key. It receives every event the phone's data channel receives and accepts
every command, so the request never leaves the machine that can answer it.

**Two files, and the split is what makes any of this checkable.**
`src/ai/voice/sideband.ts` is the socket — attach, hand each frame over, put a
frame on the wire, and make sure the cost is written down however the
connection ended. `src/ai/voice/delegation.ts` is what the frames *mean*, with
no connection in it, for the reason `adapters/matter/settling.ts` is its own
file: reading these rules through the socket means dialling `api.openai.com`,
so a rule every spoken request in the house goes through would be a rule no
test could reach. `test/voice-sideband.test.ts` drives it frame by frame — and
that suite is the only verification this loop has ever had, since the phone's
version of it lived in a repository with no test target.

**The API's own rule is one owner per action**, because both connections see
everything — so the split is written down rather than left to whichever side
happens to react first. The sideband owns **delegations** (the phone answers
none), **the transcript** and **what the line cost**. The phone owns the
**audio** and the live captions on its page, and it is the phone that sends
`session.close`, because it is the thing somebody presses stop on.

**A spoken round is answered at `low` effort where a typed one is `medium`**,
and the knob is on the turn (`ChatTurnContext.effort`) rather than on the
conversation, because a transport is built once and holds the history while one
conversation is both — typed in the morning, talked to in the evening. The
reason is the wait itself: a typed answer is read when it lands, so thinking
longer is free, and a spoken answer is a person standing in a room with the
voice having already said "one moment". The work behind most spoken requests is
also smaller than it looks — one tool call against a catalog the agent can
already see — so what the extra effort buys is deliberation about a decision
that was never in doubt. Nothing configures it, and nothing else uses the
override.

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

**Spoken or merely known, and the session's own clock is what decides.** The
answer goes back as `session.commentary.append` when it still matters and as
`session.thinking.append` when the person has moved on — the API's rule about
not announcing an outdated result, kept without throwing the fact away, since
by the time the hub answers it has *already done the thing*. What tells the two
apart has to be the timeline, and the first version counted fragments instead.
That is wrong in the ordinary case rather than at an edge: the model asks for
help the moment it has understood, so the closing fragments of "turn the
kitchen light off" are transcribed **after** the notice, and a fragment counter
demoted nearly every answer in the house using the very sentence that had asked
for it — a voice assistant that silently stops speaking its answers, which
looks exactly like a model that has decided to be quiet. So a delta's
`start_ms` is compared against the delegation's own offset: before it, the
fragment is already inside what was sent and is dropped (keeping it would also
put "off" on the front of the next request); after it, the person really has
said something new. With no timeline at all — a build of this API that stops
sending one — the answer is **spoken**, because a slightly late sentence about
something already done costs far less than never hearing that it happened.

**The same clock separates two things said from one.** The deltas carry no
punctuation between utterances, so "Hi", a pause, and then "turn the kitchen
light off" concatenated into one line — which is what the agent was asked, and
what the transcript row an app draws then showed, with the greeting stuck on
the front of the request as if it had been part of it. A gap of
`UTTERANCE_GAP_MS` (2 s) between one fragment's end and the next one's start is
written down as a **line break**: the agent reads two sentences, and the row
has them on two lines. Silent when either end of the gap is unknown, which is
the honest answer rather than a guess — a build of this API that stops sending
a timeline gets exactly the behaviour it had before. The iOS app's
`VoiceConversation.captionGap` is the same number doing the same job on the
live caption — measured on the same clock rather than on arrival, which is what
makes "the two agree about where one thing said ends" actually true.

**And what the voice answered by itself is not carried onto the front of the
next request.** `heard` was one buffer cleared only when a delegation took it,
which was right while every round went to the backend and wrong the moment the
policy told the voice to answer some things itself — a greeting, a repeat,
"what else can you do". That utterance stayed in the buffer, so the *next*
request was assembled out of both. Caught on a recording of a real
conversation: "what else can you do", answered aloud, reached the agent glued
to "tell me what's on then" as one two-line question, the agent answered the
pair, and the answer the voice had already given vanished off the page — the
phone drops a caption the moment a row lands that covers it.

So what has been heard is a **list of utterances** with their spans rather than
one string, and `session.output_transcript.delta` — which the sideband had no
case for at all — is what retires one: when the voice speaks after an utterance
has ended, and the person then opens a new one, that utterance is marked
answered and left out of the request. **The newest is never retired**, and that
single line is what keeps it safe: the policy asks the voice to say what it is
doing *before* it goes and does it, so "one moment" is assistant speech landing
a beat after the very request about to be delegated, and retiring on it would
hand the agent an empty question. With no timeline nothing is retired, which is
the conservative direction — too much context beats too little. The bound is
the same `CONTEXT_CHARS`, dropping whole utterances oldest-first rather than
slicing a string mid-word.

**The answer is written for the ear at the other end, which is where that
belongs.** For a while the voice prompt asked GPT-Live to relay the assistant's
answer word for word and never restate it, so that the row an app draws and the
sentence somebody hears would be the same. Two things were wrong with it.
`session.commentary.append` is documented as content "the model is trained to
paraphrase", so the rule was fighting the model's training for something the
API never promised. And it was defending the wrong text: the assistant writes
into a three-inch phone column, bold and bullets included — exactly what
OpenAI's delegation guide means by keeping "Markdown intended for display in
the backend" — so the voice was being asked to unfold a list it should never
have been handed.

So the **backend is told when it is being spoken to**. `askAloud` puts one line
on `ChatSession.priming` — the channel that reaches the model and is never
written down, so the transcript row stays exactly what the person said — and
the assistant's system prompt carries a *SOMETIMES YOU ARE BEING SPOKEN TO*
section it switches on: no formatting at all, numbers said the way a person
says them, one or two sentences, a transcript read as speech rather than as
something typed carefully, and nothing announced as done that was not done. The
rules live in the system prompt because it is byte-identical for the life of a
build and sits behind a cache breakpoint, so only the marker is paid for per
turn. What is left in the voice prompt is the half the model can actually keep:
every fact and number survives, nothing is added, and a caveat is not dropped
for being inconvenient.

**A spoken turn also carries what everything is doing right now**, which is
the one thing the cached first message cannot. The home goes into that message
rather than behind a tool because a round spent asking "what devices do you
have" is a round somebody watched go past — and live *values* were the
deliberate exception, since it is written once and sits behind the
conversation's cache breakpoint, so a snapshot put there would be answered from
confidently an hour later. `get_device` is the right answer for a chat. Out
loud it costs a whole model round: "is the kitchen light on" runs one round to
call the tool and a second to say the answer, which doubles the term that
dominates a spoken exchange, on the class of question that is most of what
anybody asks a house. So `spokenStateDigest` builds one **at the moment of the
turn** and puts it on `priming` beside the marker — fresh by construction,
never in the transcript and never in the cached message. Four bounds keep it
worth paying for on every spoken turn: only what somebody asks out loud (on,
bright, warm, humid, locked, open, playing, offline, a battery under 20% — the
device card's own threshold); an endpoint with nothing to report is left out
entirely, which in a real home is most of the buttons and remotes; it is keyed
by **id**, because the first message is already the index and a house with two
lamps called "Lamp" has to stay unambiguous; and it uses the same raw units
`get_device` does, because two vocabularies for one reading is how a model
comes to say twenty-one degrees about 2,140 of something. A fifth bound is on
the *house* rather than on a device: `DIGEST_LIMIT` caps how many readings one
round carries, since this is rebuilt and re-sent every spoken round and a home
grows. A cut list **says how many it left out** and sends the model to
`get_device` for them, because the sentence above it claims that anything
missing is reporting nothing — which a silent cut would turn into the hub
telling the model something untrue about a hundred devices.

**And it says out loud that it replaces the tool call**, which is the half that
makes it pay. Two other places point the model straight at `get_device` for
exactly this — its own description ("before working a device whose exact
endpoint or *current value* matters") and the system prompt's *Look before you
act* — and both are right for a typed turn, where the trail showing "Looking at
one device closely" is the wait being made legible rather than the wait itself.
So the digest is directive: the reading is current, a device missing from it is
reporting nothing, a plain reading is answered from it, and the things that
genuinely still need the tool are **named** — a colour, a thermostat's limits, a
fan percentage, a battery that is not low, settings, learned buttons. Vague was
not good enough: "call get_device for anything else" is an invitation, and a
model with two nudges towards a tool and one weak hint away takes the tool. The
spoken section of the system prompt carries the same rule, since that is where
behaviour is set and it is cached.

**And a round that outlives the phone's patience says so.** The app closes a
line after a minute with nothing said and nothing playing, and the assistant is
allowed a two-minute round — so a slow answer arrived at a session that had
already hung up, and the person heard "one moment" and then nothing, ever.
Making the phone more patient is the wrong side to fix it on: that clock exists
for a page left on a kitchen counter, where being generous is a meter running in
an empty room. This side is the one that knows a round is running, so every
`PATIENCE_MS` (20 s) an unanswered delegation gets a `session.commentary.append`
on its own id saying it is taking longer than usual — the model speaks, the
phone's transcript deltas reset its clock, and the wait stops being silence. It
says nothing about *what* is happening, because the hub knows a round is running
and no more; "checking the kitchen light" would be a sentence invented here
about a tool call nobody here can see. It is a signal rather than a guarantee —
the model decides when to speak — but what it cannot do is leave this side
silent for a minute, which is the failure it replaces. An ordinary round
finishes in two or three seconds and never sees it.

**A question is an answer, and for a while it was a refusal.** `askAloud`
returned `agent` and `note` rows only, which covers the two arms a typed reply
usually ends in — and silently drops the third. `ask_user` is precisely where
the assistant's own prompt sends it when a request is ambiguous in a way that
changes what it would *do* ("which of three lamps", "the room or the house"),
which is the commonest thing to be ambiguous about out loud. The scan fell off
the end, the sideband read `null` as "that could not be worked out", and
somebody who had just asked for a light to be turned off heard a refusal while
a perfectly good question with two tappable options landed on a page in their
pocket. Question rows are spoken now, with their **options folded into the
sentence** — the model writes the choices into `options` and leaves the
question bare, and "Which one?" is not answerable in a room. The reply comes
back through `askAloud` as another spoken turn and `say(…, 'auto')` already
routes it to `answer`, so nothing else had to change.

**Audio does not reach the sideband, and the claim that it did was read across
from the wrong transport.** `session.input_audio.append` and
`session.output_audio.delta` are **WebSocket only**; a WebRTC session carries
its media on the negotiated track, so there is no JSON audio in existence for a
sideband to be sent copies of — which makes the old "about a megabit a second,
and that is the price of attaching" simply untrue of every session this hub
opens. The two event names are still dropped on sight, because that costs one
set lookup and the one session shape that *would* flood a sideband is the one a
later change might reach for. `frameType`'s **bounded prefix** earns its place
on the transcript deltas instead, which really do arrive several times a second
and are mostly of no interest here; JSON promises no field order, so a frame
whose `type` sits past the prefix falls through to a full parse. Every frame
this API actually sends puts `type` first, and `test/voice-sideband.test.ts`
pins both halves.

**An answer is capped at 500 tokens, and the cap is set from the worst side.**
The three append events take at most that much plain string and refuse anything
over it — which on this surface is not an error anybody sees, it is a person
standing in a room hearing nothing back. `LIVE_APPEND_CHARS` was 1,800, from
four characters to the token, which is English: Cyrillic runs closer to two, so
a Russian home hit the cap at about half the length an English one did and the
refusal landed on exactly the homes least likely to be testing this. Nine
hundred is inside 500 tokens in either script and is still around fifteen
seconds of speech — far more than a spoken answer should now be. A refusal that
does happen is named as one: `error.client_event_id` correlates back to the
append that failed, so the log says the session refused an answer rather than
"the session reported an error".

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
not crowd out the policy above it.

**And the policy has to say what those names are *for*, because the model is
looking at the list and not at the heading over it.** Asked what scenes the
home had, the voice read the list back and said that was all there was — on a
home with three, off a list that deliberately leaves out the `watching` rules
and the switched-off ones, in a confident sentence nobody could tell was
invented. It is a snapshot for pronunciation and it says nothing about what
anything is doing, so every heading is hedged (`SOME ROOMS, BY NAME`), the
"do not delegate" clause names the backend as where a still-current result came
from, and one sentence says plainly that what the home has, what it is doing
and what a scene does are the backend's answers every time, even when a name is
right there. `test/voice-prompts.test.ts` pins the labels, the bound and this,
because the way this regresses is somebody flattening the policy into prose or
copying the assistant's prompt back in.

**It is the same transcript**, which is the part worth having. The rows are the
round's own, written here, so the page fills in while somebody talks, is there
when they open it afterwards, and can be *continued* by typing — `revive()`
rebuilds a model conversation from exactly those rows, so a typed follow-up
reaches an agent that has read what was spoken. It runs the other way too: when
the app sends a session id it already has, that conversation's last few
exchanges are seeded into `session.input`, so pressing the microphone on a page
you have been typing on carries one conversation on rather than starting a
second beside it. **That seed is bounded twice**, because the API bounds it
twice: 128 messages *and* 8,192 tokens, of which only the first is a count
anything here could keep by itself — a transcript row holds up to 4,000
characters, so a dozen long answers cleared twelve messages easily and had the
session creation refused outright, which repeats on every attempt because the
history that caused it has not changed. `LIVE_HISTORY_CHARS` is the second
bound, in characters and set from the worse script for `LIVE_APPEND_CHARS`'s
own reason, spent newest-first.

`beginVoice()` is still only an id and a mark: what it opens
is a conversation nothing has said anything in yet, which is why `askAloud`
reaches for `open()` — there is no transcript to revive from until the first
question arrives. **`open()` is also the one arm that refuses nothing**, so it
is guarded: a session id belonging to another member is refused by
`maySpeakInto` rather than opened under their transcript, which is `revive()`'s
own ownership rule held one arm further along. The route answers
`409 not_your_conversation` for it, before anything is opened or spent.
**And the mark is set after the sideband is attached, never before**: attaching
replaces whatever sideband the conversation was holding and a replaced sideband
settles, which is what *clears* the mark — so marking first meant stopping and
restarting the microphone quickly cleared the mark the new line had just set,
and a session nothing attaches to would stay marked for the life of the
process. That mark is what keeps **one word in the activity log** true: a command
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
that never said anything records nothing rather than guessing. What is billed
is clamped to `SIDEBAND_MAX_SECONDS`, because the sideband is the thing doing
the reading and nothing can have cost more than it stayed attached for — it
said half an hour against the sideband's hour for a while, on a reason that had
already gone (an ephemeral client secret, from the design WebRTC replaced).

**But a session that never said still has to be settled**, which is the half
that was missing and the one the ledger does not see. `session.usage.updated`
arrives about **once a minute**, so the sessions that carry no number at all
are precisely the short ones — a phone force-quit forty seconds in, a train
tunnel. Settling does two things: it writes what the line cost, and it clears
the `spokenSessions` mark. Hanging both off there being a number meant the mark
survived exactly those endings, so a follow-up typed into the same conversation
hours later was logged as speech. Zero settles, and writes no row — `$0.00`
against a line that plainly ran is a claim where nothing is the truth.

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

There is a fourth field now, `decisionCriterion`, and it exists because the
same job has to be described twice for two readers. `description` is written
for a model reading tool documentation and says what the agent is *not* for —
"Not for switching something on now, and not for questions about a rule" —
which is two negatives in one clause, and a documented weakness of the
[decision model](jev.md) that also has to choose between these agents.
`decisionCriterion` is the same job as a plain positive statement. Both come
off the same entry, so a third agent is still one edit.

## Deciding before the model is asked

A typed turn and a spoken one both begin with one request to a decision model,
carrying the routing questions, the guards, the home's catalog and every action
family at once (see [jev.md](jev.md)). Most sentences come back with nothing to
act on and the round runs exactly as it always did. Four do not:

- **A plain command — to one device, or to every device of one kind in a
  room, a zone or the house** — is carried out immediately, through the same
  `control` path the model's own tool uses, and the round is then primed with
  an exact account of what was done (`fastPathPriming`: every device by name,
  what was done in words, what failed and why, what was offline and not tried)
  so the model writes the sentence and nothing else, at the lowest effort. One
  round instead of two, and the light moves first.
- **A sentence that is several requests with a command among them** is split
  by the conversation's own model into its parts, the parts are read in one
  more request, and every part read confidently is carried out; what is left —
  a question, a rule, a part it was unsure of — is the model's, quoted in the
  same account. "Turn off the light and what's the temperature?" is the light
  off before the model is asked, and the model answering the question.
- **A self-contained automation request** is handed straight to the automations
  agent through `delegate` — the same call, so the permission check and the
  resume behaviour are unchanged. Typed only: `spoken()` drops a `handoff` row,
  because the handoff arm writes its own `agent` row, so skipping the round out
  loud would leave `askAloud` with nothing to say and the voice would announce
  that it could not work it out, over a job handed over correctly.
- **A plainly small request** runs its round at the lowest effort.

The hub writes **no prose** on any path. A hub-written "I have passed that on"
or "Done" is words in the model's mouth, which is the rule the automations
agent's own prose arm is built around. Out loud the voice then says what the
model wrote, so a spoken command is a light going off and a sentence about it
that the assistant composed from what actually happened.

Every gate falls through to the round that would have happened anyway, so
being unsure, being wrong about the shape, getting no answer at all, or the
fast path failing outright each cost exactly what the hub cost before — the
whole of it sits under one `catch` whose answer is the model's sentence, whole.
And a command it carried out is never carried out twice: `control` remembers
what this turn did, so the model calling the tool anyway is a no-op, while a
command the device refused stays a real second try.

**And the round's working says which road it took.** Acting puts a step up
first — `kind: 'routing'`, *Jev switched off 2 lights in the Kitchen*, with the
reading's time and confidence beneath it — and so does splitting (*Jev heard 2
requests*, over the parts) and handing over (*Jev passed this to the
Automations agent*); standing down where somebody could have expected the other
road is `kind: 'deferred'`, *Jev wasn't sure which device*, with the answers
and the bar they missed as its detail. Every road is also a line in the hub's
log (`Jev carried out — …`, `Jev stood down — …`); a sentence read confidently
as a question is logged and not drawn, since that is most of them. The model is
told what was done and never why something was not — the reply is its to write.
`docs/jev.md` has the tables.

## Getting ready while somebody is still talking

The sideband already receives the person's transcript in fragments, several
times a second, well before the model says the sentence has finished. That gap
is where the expensive part of a spoken exchange sits: the conversation has to
exist, the transport has to be built, the vendor client has to be imported for
the first time on a 1 GHz core, and the home's current readings have to be
gathered. None of it depends on how the sentence ends.

`VoiceDelegationHost.warmForSpeech` does exactly that, and **cannot do anything
else** — the interface is narrowed so a warm has no way to reach the home at
all. "Turn the bedroom light on — no, off" is an ordinary thing to say, and a
hub that acted on the first half would make the lamp flash; the write waits for
`session.delegation.created`, which is the model saying the sentence is
finished.

Bounded four ways: one at a time, a minimum gap, a cap per utterance, and never
while a delegation is being answered. The per-utterance cap is the one that
matters — a room with a film on produces transcript fragments indefinitely,
which is the voice prompt's own "don't treat a television as a request" hazard
one layer down.

Because the warm is a side effect on the session map, `askAloud`'s own lookup
simply hits when the real sentence arrives — so there is no second parameter to
thread and **no way for a warmed session to be the wrong one**.

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
