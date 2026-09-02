# Automations

Canonical for `src/automations/`. Read this before touching the DSL, the
engine or the guards. `docs/api.md` is canonical for the routes and the socket
frames.

An automation is a rule the home runs by itself. **A scene is an automation
with a manual trigger** — there is no second system for scenes and there
should not be one, because "press this and the house does that" is this object
with one trigger kind.

---

## The two halves, and why they are separate

| | Runtime | Authoring |
|---|---|---|
| Runs | always, for years, offline | minutes in a hub's life |
| Needs a key | **no** | yes |
| Needs the network | **no** | yes |
| Deterministic | required | not required |

The consequence is a rule, not a nicety: **`ai_enabled: false`, or a deleted
API key, stops automations being *written* and does not touch the ones that
exist.** "Stop spending my money on this for now" must not put the lights out
on a schedule.

---

## The document is data

`AutomationDocument` (`src/automations/schema.ts`) is zod-validated and
**interpreted, never executed** — the `MappingDescriptor` rule, held up here by
five things rather than one:

- **The process holds the house.** The service account can read
  `<data>/hub-secret.json` (the key every AI credential is encrypted with), the
  token hashes in SQLite and `<data>/update/`, where a write starts a root
  unit. A rule written by a model — or by a guest who lives here — must never
  reach any of that, and `vm` is not a security boundary.
- **There is no compiler on a Pi.** The bundle is `dist/` plus production
  `node_modules`.
- **A rule has to be shown to a person**, in their language, on a phone.
- **A rule has to be checked before it runs** — does that device exist, does it
  have that capability, will this fire two hundred times a day, does it form a
  cycle with another rule.
- **A rule outlives the build that wrote it.** `install.sh` rolls back on a
  failed health check, so a document saved by a newer hub meets an older one.
  `version` is defaulted rather than required for that reason, and a document
  this build cannot parse is **kept, reported and not run** rather than
  crashing or silently skipping a step.

```
AutomationDocument {
  version, name, description?
  mode: single | restart | queued
  triggers[]        // OR
  conditions[]?     // AND
  actions[]         // in order
  offActions[]?     // present ⇒ this is a toggle; needs a manual trigger
  guards?           // author limits, only ever stricter than the engine's
}
```

### Targets are selectors

```
target = { deviceIds[], endpointId? } | { select: { capability?, kind?, roomId?, zoneId? }, endpointId? }
```

A selector says *what* rather than *which*, and it earns its place three times
over: "turn off all the lights" is the commonest automation there is; a lamp
paired next month joins "Night" with nobody editing anything; and a template
authored months before it meets a home cannot name a device. Capped at 64
devices — the per-device guards are what actually protect the hardware.

`endpointId` is optional and absent is the useful default: the engine picks the
endpoint carrying the capability the command needs, so a two-gang switch does
the obvious thing without the author knowing it has two endpoints.

**Reachability is deliberately not a filter.** A command to a sleeping battery
device is queued by the protocol and lands when it wakes, so dropping
unreachable devices would silently un-target half a home of sensors and make a
rule's meaning depend on when it happened to run.

### `deviceState` is edge-triggered

The test runs on every report and **fires only on the crossing**.
Level-triggering would be a quiet disaster: a battery at 12% reports hourly and
would announce itself hourly for a month; a plug drawing 3 W would say the
washing machine finished every few seconds, for ever.

The **first** evaluation of a (rule, trigger, device) adopts the answer and
fires nothing — the `REACHABILITY_QUIET_MS` judgement, applied to rules: a
rule fires on a transition it *watched*, and a hub that has just come back has
watched none.

That means triggers must be **primed against the home as it is**, which
`rebuildWatchers` does on every load. The engine only sees a device when it
*changes*, so without priming a trigger would treat the first change it ever
observed as its first sight and swallow it: a motion rule installed at noon
would ignore the first person to walk past, on every boot and every reload.

### `for` and `hysteresis`, and why one is mandatory

On a path marked `continuous` in `READABLE_PATHS` — power, temperature,
humidity, light level, air quality, pressure, flow, particulates, CO₂ — a bare
threshold is **refused** by `sanity.ts`. This is `STATE_FLUSH_MS` pointed at a
relay instead of an SD card.

- `for` is "and it stayed there": suppresses a spike.
- `hysteresis` is a band the value must come back through before the trigger
  re-arms: suppresses a reading sitting *on* the threshold and dithering
  across it. An edge alone does nothing about that, because every wobble is a
  real edge.

Actuator positions (`level.current`, covering, fan) are deliberately **not**
continuous: they move when somebody moves them, so a threshold on one is a
statement about an action.

### Actions reuse `HubCommand`

`commandSchema` unchanged — no second vocabulary of verbs. IR *library
management* (learn, save, rename, delete) is refused; `irSend` is what a rule
wants. A `wait` is capped at fifteen minutes because **it does not survive a
restart**; anything longer is a `schedule` trigger, which does, because it is
derived from the clock rather than from a suspended run.

---

## Two lists come back from a check

`sanityCheckAutomation` returns `{ problems, warnings }`, and the split is
load-bearing.

**A problem is a refusal.** The rule would not work, points at nothing, or
would hurt something.

**A warning is saved and reported.** The clearest case is a cycle: A turns the
light on, B watches the light and turns the heater off, and B's change reaches
A. Sometimes that is a bug and sometimes it is a thermostat, and this module
cannot tell which — so it says so, the agent gets the sentence back, and the
person sees it in the preview before enabling anything. Refusing would forbid a
legitimate shape; silence would ship the commonest way home automation goes
wrong.

---

## The guards

`src/automations/guards.ts`. Five layers, cheapest first, and **every one of
them applies to automation-driven commands only** — a person tapping a card
quickly is a person, software tapping quickly is a bug, and that distinction is
why the limits can be this tight.

| | What | Why |
|---|---|---|
| 1 | **Idempotence** — a command that would leave the device where it is never leaves the hub | One comparison against a cache the hub already keeps; absorbs most flapping and is why the rest rarely say no |
| 2 | **2 s minimum per endpoint** | A relay rated for 100 000 operations switched once a second is dead in a day and a half |
| 3 | **~60/hour, ~600/day per device** | For a rule switching something legitimately different each time, which slips past idempotence |
| 4 | **Causation and a depth cap (3)** | Our own commands are remembered for five seconds, so a report that follows one is known to be our doing and carries a depth |
| 5 | **A circuit breaker** — 20 runs in 10 minutes switches the rule off | The backstop that works when attribution fails; the only layer that changes stored state, and it writes `disabled_reason` and one activity row |

**Attribution is recorded before the write, not after.** Zigbee2MQTT publishes
optimistically, so a mains device can report its new state before `execute`
resolves; with the record afterwards, `causeOf` answered "nobody" for precisely
the reports our own commands caused, every link of a loop restarted at depth 0,
and no chain could ever be cut. It also means a command the radio refuses still
spends its slot, which is right: the device was asked.

Three commands are **never** idempotent and must not be treated as such:
`toggle` is defined by what it does, `stopCovering` is an interrupt, and
`irSend` is a transmission with no state behind it. A value the device has
never reported always sends: silence is not evidence.

---

## The clock

- The scheduler ticks every 20 s (`unref`ed), so a minute cannot be stepped
  over.
- **Nothing is made up.** The tick fires for the minute it is *in*. A heater
  told to come on at seven does not come on at nine because the power was out.
- **Everything is held while the clock is implausible** (before 2025). A
  Raspberry Pi has no RTC: it boots into a fictional time that NTP corrects
  seconds later, and a scheduler running in that window would fire every rule
  whose time happened to match. Nothing is lost by waiting — the right minute
  comes round.
- An `interval` **arms** on the first tick rather than firing: a restart is not
  an interval elapsing.
- The home's timezone is a setting seeded from the system's and owned by the
  database afterwards — the `HUB_NAME` split. An unusable zone is refused at
  the route rather than taking every schedule down on every tick.

---

## What is written down

| | Bound | Why that bound |
|---|---|---|
| `automations` | none | A home has a dozen and a person made every one on purpose |
| `automation_versions` | 10 per rule | A bound on *bulk*, the `device_portraits` shape — an edit is deliberate and a document is two kilobytes |
| `automation_runs` | 20 per rule, 14 days | Per rule rather than globally, the `history.ts` prune argument: a global cap lets one chatty rule evict every trace of a quiet one, and "why did this fire" has to be answerable for the rule somebody is asking about |

**Only a manual run reaches the activity log.** That is the log's own rule —
what was *asked*, never what was reported — and a motion rule's forty daily
firings would drown a feed bounded at 5 000 rows. The one exception is the
circuit breaker switching a rule off, because that is a discrete transition
somebody has to be able to find a week later when they notice the hall light
has stopped working and nothing on any screen says why.

A trace records the commands a guard **refused** as well as the ones it sent:
"nothing happened" and "the hub declined to switch that relay for the fortieth
time this hour" look identical from outside.

---

## The catalog is generated

`automationCatalog()` builds the reference from the live zod schema
(`z.toJSONSchema`) plus one sentence per node kind. One source feeds three
consumers — the agent (as a tool result), the apps (as a "what can this do"
screen) and this document. A hand-written catalog drifts from what the
validator accepts, and it drifts **silently**: the `GET /permissions` rule
applied to a vocabulary that will keep growing.

**Units are the part that has to be right.** Level is 1–254, temperatures are
centi-degrees, a covering's 0 is *open*. A model that writes 22 for 22 °C
produces a rule wrong by two orders of magnitude that looks perfectly
reasonable, which is why every path and command in the catalog carries its unit
in words.

---

## Templates

Written with **selectors, never ids**, so one authored months ago installs into
a home whose devices nobody has seen and keeps meaning what it said as that
home changes.

`build()` returns an **array**, because "light on movement" is genuinely two
rules — one for arriving, one for leaving — and an action list runs top to
bottom with no branch in it. Inventing an if/else in the DSL for a case two
documents express perfectly would be the wrong trade.

Two things are deliberately absent. **Nothing unlocks on the way out of a
mode**: a rule that opens a house because somebody tapped a card is not a
convenience, and an action list cannot ask "are you sure". And there is **no
water-leak template**, because there is no leak capability — one that quietly
matches nothing is worse than none.

---

## Two words that must not be confused

| | Means | Permission |
|---|---|---|
| `enabled` | the rule exists and is listening | `automation.manage` |
| `active` | a manual toggle is switched on right now — "Security is on" | **the floor** |

Pressing "I'm leaving" switches lights, and working the home is what being a
member means — the same argument that killed `device.control`. A role that may
work every light individually but not the button that works them together
would be a rule nobody asked for. Writing what that button *does* is the
permission.

New rules are created **switched off**, whatever the caller asks for. The
moment between "here is what I wrote for you" and "your house is now doing it"
is the only one in which somebody can still look.

---

## Writing one in conversation

`src/ai/automation-*.ts`. The agent is **authoring only**: the runtime above
does not know it exists, runs without a key, and keeps running when the key is
taken away. `ai_enabled: false` stops rules being written and touches nothing
that is already running.

On the hub, as a plain Messages API loop. Not the Claude Agent SDK, for the
reason `agent.ts` is not — a 276 MB binary and a ~315 MB subprocess per run is
unusable on the smallest board this hub supports — and **not a cloud agent**,
for a reason of its own: this agent's tools are the home, the home is on a
local network, and a provider's container cannot reach it. Every tool call
would have to be relayed back through a tunnel that does not exist.

### Seven tools, and no web

`list_devices`, `get_device`, `list_rooms_zones`, `get_automation`, `dry_run`,
`ask_user`, `submit_automation`. There is no search and no fetch: an agent
writing a rule for somebody's house has nothing to look up, and leaving the
tools out is a plainer promise than any prompt about not using them. This is
the one AI surface in the hub that talks to the provider's API and to nothing
else at all.

**`ask_user` is what makes this usable by somebody who does not write
software.** It carries two to four options, because a person taps one and will
not compose an answer to "what should the hysteresis be?". Answering closes the
tool call it opened — a plain user message after a pending call is a
conversation the API refuses — which is why `answer()` exists beside `send()`,
and why a *typed* reply to a question is routed to `answer` anyway.

**`dry_run` is the agent checking its own work.** It runs the same checks
`submit_automation` runs and hands back the sentence the apps will show, which
is the best available test of whether a rule says what somebody meant.

**`submit_automation` is the only answer channel**, and a refusal is a
`tool_result` rather than the end of the conversation: the model fixes the
document and resubmits without the person ever seeing that it got it wrong
once. Deliberately not a `strict` tool, the `submit_mapping` reasoning — strict
mode guarantees the shape and cannot express "the target must have that
capability".

**Where a wider world would attach, when there is one.** The obvious next thing
somebody wants is a rule that reaches beyond the house — a web API, an MCP
server, a service that knows something the hub does not. That lands in exactly
two places and nowhere else: a row in `automation-tools.ts` for what the
*agent* may look up while it writes, and a new action kind in `schema.ts` for
what a *rule* may do when it runs. Both halves are needed and they are separate
decisions: an agent that can read a forecast while deciding what to write is a
research tool, and a rule that calls out on every firing is a network request
from inside somebody's home on a schedule — with the request-forgery problem
`page-fetch.ts` already had to solve for the mapper, and the same answer waiting
(an allowlist, checked per redirect hop, against a resolved public address).

Nothing here is shaped to prevent it: the tool table is a list, the action union
is a union, and the catalog that feeds the prompt, the apps and these docs is
generated from the schema — so a new action kind is described everywhere the
moment it parses. What is *not* wanted is the shortcut: a general "call this
URL" action would be that forgery primitive with none of the guards, and it is
the one thing this design deliberately does not have.

### A conversation suspends, twice over

Unlike a mapping run, which is one call that either produces a descriptor or
does not, this loop hands control back on `ask_user` **and** on a prose ending,
and both suspensions outlive the request that started them. So a conversation
is an object with a lifetime, and the provider — not the caller — owns the
message history, because that history is the vendor's own shape.

### Two stores

- **In memory**: the provider's message history. Tens of kilobytes a round,
  needed only to continue, dies with the process.
- **On disk**: the transcript an app draws. A few hundred bytes a message,
  kept 14 days.

### The rows an app draws

A transcript row is `{id, at, role, text, data?}` and `role` is an **open**
vocabulary — the `activity.message` rule again, so a word a client has never met
falls through to prose rather than being dropped. `text` is always the sentence;
`data` is what lets an app draw more than one.

| `role` | `text` | `data` |
|---|---|---|
| `user` | what was typed | — |
| `agent` | what the model said | — |
| `question` | the question | `{options: [{id, label, hint?}], allowFreeText}` |
| `preview` | the rule's **summary**, from `describeAutomation` | `{automationId, name, shape, enabled, edited}` |
| `note` | something the hub is saying on its own behalf — a provider that failed, a rule that could not be saved | — |

**A submission writes two rows: the model's line, then the card.** They say
different things and the card cannot do both jobs — it carries
`describeAutomation`'s sentence, which is the *rule*, worded the same for
everybody and mechanical by design, while the line above it is the answer to
what was actually **asked**: what changed, in the person's own language, with a
caveat if there is one. On an edit ("make it 10 lux and put the name in
English") the card alone never says whether that was done.

The line is the model's own prose from the submitting response, and it was
empty for a while for two reasons that compounded. The instruction to write it
lived in `submit_automation`'s own *result* — "tell them what it will do,
briefly, and stop" — which the model can never act on, because accepting a
submission ends the turn and that result is only read on the next one, where it
is stale advice about a rule from last time. And the paragraph above it in the
system prompt read "prose is not an answer", which is true about *delivering a
rule* and reads as "do not bother writing any". So the prompt now asks for the
line **in the same message as the call**, and says what it is for — not the
rule again, which is the card. It is never written by the hub or the apps: a
canned "All done" is words in the model's mouth, and the same reason both chats
give an empty page a stage rather than a fake greeting.

Two fields on `preview` are there because leaving them out was wrong in a way
only a real app finds. **`name`**, because `text` is the summary rather than a
title, and a client without it would have to look the id up in a list it may not
have refetched yet — drawing an untitled card for the second that takes.
**`enabled` read back from the store rather than assumed `false`**: a rule
written from scratch really is switched off, but an *edit* lands on one somebody
already chose to have running, and the hardcoded value said "saved, switched
off" about a rule that was at that moment switched on.

A restart therefore costs the *continuation* and not the record — and the
continuation is rebuilt from the record, because the two lifetimes are two
hours and a fortnight. Sessions expire after two hours idle (at most eight held
at once), while the transcript keeps for fourteen days, so "the hub has
forgotten how to go on" was the ordinary state of everything in the
conversations list rather than an edge: both apps drew a closed composer over
conversations that had worked perfectly, and nobody could ask one to try again.

`revive()` builds a fresh provider conversation under the **same session id**
and primes it with a recap of the stored rows, so the person sees one
continuous chat and only the model's memory was rebuilt. Three rules. The recap
reaches the **model and never the transcript** — it is a read-back of rows that
are already there, and writing it down would put the conversation inside itself
as a message — so it rides on `ChatSession.priming` and is consumed by the
first exchange. It is worded as **history rather than memory**, because a model
told it remembers a decision it is only reading will defend that decision. And
**ownership is read back out of the rows** (`automation_chat_messages.member_id`):
a live session carries its member and `reply` compares against it, while a
revived one is built from the caller's own id — without that check any member
could reopen anybody else's conversation by its id and carry it on.

What is genuinely lost is the model's reasoning and any tool call that was
outstanding: a question it had asked is answered as ordinary prose, which is
what somebody typing into a reopened chat means anyway. `410
conversation_ended` survives for the one case that is really gone — a session
with no rows at all, never having existed or past the fortnight.

**And `GET /automations/chats` is what makes that split worth anything.** A
transcript kept for a fortnight that nothing can find again is a transcript
thrown away: closing the page lost the conversation as surely as never having
stored it, because the only way back was a session id nobody writes down. The
list carries the first thing the *person* said as its title, and `live` beside
it — readable and continuable are two different states, and an app has to say
which one it is offering rather than discovering it on the next message.

**One question is outstanding at a time, and every other call in its response
is still closed.** `ask_user` hands control back mid-response, and the API's
rule is per *response*: every `tool_use` in an assistant turn needs a
`tool_result` in the very next message. Handing back used to abandon the rest —
the calls before the question were collected and dropped, the ones after it
never ran — so the next request carried a half-answered turn and the whole
conversation was refused with `400 tool_use ids were found without tool_result
blocks`, which reached the chat as a wall of JSON where the answer belonged. The
others are run and stashed, `answer()` sends them with the answer, and a second
question in one response is refused inside the turn rather than left open.

### What it costs, and where that is written

`ai_runs` rows with `kind: 'automate'`, `automation_id` filled when the
conversation produced a rule and `exposes_hash` empty. One list, because "what
did this home spend on AI" is one question and two tables would make it two
screens. `session_id` is what makes the *conversation's* own spend answerable:
`automation_id` is null for a chat that submitted nothing, and a revived one
writes a row per incarnation, so nothing else could total them.

**A row carries the delta, never the running total.** One is written when a rule
is submitted — a conversation that has done its job should not wait on an
abandoned tab — and another when the session closes or the idle sweep takes it,
so a chat that wrote two rules writes several. Each records what has been spent
*since the last one*, or summing them would report a two-rule conversation as
having cost half as much again as it did. That is the whole of a bug this had:
`record` was once-only, so everything after the first submitted rule was simply
dropped.

**`GET /automations/chats` and the transcript route both answer with `spend`**
— `{usd, provider, modelId, model}` — and three rules hold it up.

*It is absent rather than zero when the hub cannot say.* The ledger keeps the
last sixty runs of every kind while a transcript lives a fortnight, so a home
that has recognised a few devices since can open a perfectly readable
conversation whose spend row has been pruned. `$0.00` about a chat that plainly
cost something is a claim; nothing at all is the truth — the rule
`GET /system/update`'s `available` already follows.

*A conversation still running has spent money the ledger has not heard about,*
and that is exactly the one on screen. The figure adds whatever the live
session has run up since its last row, read off the conversation itself —
without it a paid chat draws as free while somebody watches it work, then jumps
to its real number minutes after they have stopped looking. A live session also
names its **own** model rather than the last recorded one, which is the more
current answer to the same question and covers a revival running on a provider
the earlier rows never saw.

*And the model is read back, never re-derived.* `effectiveModel` answers "what
will run" and deliberately moves with the offered list; this answers "what did
run", which is a fact about a run that already happened and must not move at
all. So `provider` and `modelId` are the columns verbatim, and only `model` —
the label an app draws — is looked up: `PROVIDER_MODELS` while the model is
still offered, the raw id once it is retired. Ugly and true beats a second
table of names for models nobody offers any more, and it is the hub's answer
rather than an app's for the reason the model *picker* is. `PRICING` stays
broad for the same reason, so a months-old row still prices correctly.

Guardrails: 12 provider rounds per user message, **$1 per conversation** (on
the conversation rather than the turn — twenty rounds of clarification are
twenty requests, and a ceiling that resets every message is not one), and a
three-minute watchdog per turn rather than the mapper's ten, because somebody
is sitting in front of this.

### The prompt

Built from `catalogAsPrompt()`, so what the agent is told a rule can contain
is generated from the same schema that validates one. It names the refusals
rather than steering around them — the engine's guards hold whatever a document
says, so a prompt that begged the model to be careful would be duplicating an
enforced rule and reading as the only thing between somebody and a burnt-out
relay. And it is honest about what the hub cannot do: **there are no
notifications**, and a model that does not know that invents a notify action
and spends a round finding out while somebody watches.

The system prompt is byte-identical for the life of a build and sits behind a
cache breakpoint; the home inventory goes in the first user message, behind the
conversation's own.

### A message is acknowledged, never awaited

`POST /automations/chat` and `…/messages` answer the moment the hub takes the
message: `{sessionId, messages}` where `messages` is the person's own row and
nothing else. **This is the `POST /devices/:id/remap` lesson, and this route
shipped with the very bug that one was written to avoid** — a turn is a loop
against a provider with a three-minute watchdog, the request was held open for
all of it, and the iOS client gives a hub ten seconds. A conversation that was
working perfectly reported "the request timed out" every time, while the reply
it went on to produce arrived on a socket nobody was waiting on any more.

Three consequences worth keeping.

**The user's row is written synchronously**, so an app draws what was typed the
instant it is acknowledged rather than a beat later.

**Turns are chained per conversation.** A second message while one is running is
an ordinary thing for somebody to do, and two exchanges against one provider
history at once would interleave the messages array into nonsense. Chaining also
means `awaitingAnswer()` is asked when a turn *begins* rather than when it was
queued, by which time a question may have opened or closed.

**Every turn emits a `turn` frame, the failed ones included.** That frame is
what tells an app the stored transcript is ready to re-read *and* what takes its
"thinking" indicator down — the provider-failure path returned without one, so a
round that failed left three animated dots running for ever over a note
explaining the failure that nothing had gone back for.

### What a person sees while it works

A round is tens of seconds of the model reading the home and deciding before a
word of the reply exists, so the socket carries **four phases**, not one:

| phase | what it is |
|---|---|
| `step` | one line per thing the agent *did*, with a `kind` beside it |
| `thinking` | the model's own summarized reasoning, as it arrives |
| `delta` | the reply itself, as it is produced |
| `turn` | the exchange is over; the stored transcript is what to draw |

**A spinner is not an answer to "what is happening".** Steps used to be reported
only once something had *happened*, and the first thing that happens in a round
is none of it — no tool called, no word written — so the whole of the longest
wait was three animated dots. Two things fill it now: a step goes up **before**
the request ("Reading your home", and "Working it out" on later rounds), and the
reasoning is streamed as it arrives. That second one exists only because the
loop asks for `display: 'summarized'`; with this model's default the thinking
blocks stream empty and there is nothing to show.

**`kind` is what an app draws a mark from** — `reading` · `checking` · `writing`
· `asking` · `thinking` — and it is about the *shape of the act* rather than the
tool that did it: three tools all mean "reading your home", and an app that had
to map seven tool names would need updating every time the agent learns an
eighth. It is an open string, so a word a client has never met falls back to a
neutral mark and still shows the sentence.

**The sentences live in `automation-tools.ts`**, beside the tools, so adding one
puts its wording in the same edit. They are sentences rather than tool names:
`Looked up list_rooms_zones.` is a function signature read out loud, on the one
screen whose whole job is telling somebody who does not write software what
their house is doing. Present tense and unfinished, because a step goes up while
it is happening.

**And the working outlives the wait.** The steps used to be a stream and
nothing else: they filled the seconds before a word of the reply existed and
were gone the moment the turn landed, on the reasoning that the answer is the
content. That holds for a dozen open rows above every answer somebody ever got,
and it does not hold for the *fact* that there were a dozen — a rule arrives out
of a handful of tool calls, and discarding all of them leaves the one page whose
job is explaining a house to somebody who does not write software with nothing
but the conclusion. So the round's steps are written into the **first row that
round records** (`data.steps`, `[{text, kind, detail?}]`), whichever kind of row
it is, and an app draws them folded above the answer.

Five rules hold that to the size of a transcript row.

**The first row of the round, not each row.** A submission writes the model's
line and then the rule's card; the working is one account of how the round got
there, so a copy between the two would read as two rounds.

**Every kind of ending, including the ones that failed.** Prose, a question, a
line plus a card, or a note saying the model could not be reached — the working
is worth the same in all four, and most in the last. So the rule is a *position*
rather than a list of cases, which is also what keeps a row shape added later
carrying it without knowing it exists.

**The person's own row never takes them**, and the round's buffer is cleared
when a round **begins** rather than when it ends — so a turn that throws between
the two cannot hand its working to the next round's answer.

**Twelve, and the last twelve.** A transcript row is a few hundred bytes by
design, and this is the one field that could quietly make it kilobytes; twelve
covers every round this agent actually runs, and a round that did more than
twelve things went wrong in a way those twelve show. The *last* twelve, which is
the direction an app's live trail drops from as well, so what somebody watched
is a suffix of what they read back rather than a different set. A long sentence
or detail is **cut rather than dropped**: a step that ran over still says what
it was.

**And it is the `step` frame's own three fields.** An app draws the live trail
from the frames and the stored one from these, so one shape rather than two that
would drift; `kind` stays open there too.

### Which provider it runs on, and it is not the mapper's

**This agent picks its own, deliberately.** `ai.provider` answers "which model
reads a device's exposes tree" — a real choice, because both halves of *that*
are written. Only one half of this one is, so reading the same field turned an
unrelated preference into a refusal: a home with both keys that recognised
devices with OpenAI could not write a rule at all, with a perfectly good
Anthropic key sitting beside it. So it runs on Anthropic whenever the home has
a key that can, and switching the *mapping* provider changes nothing about
whether rules can be written, in either direction. A legacy subscription token
is not such a key — the loop authenticates with `x-api-key` — so a home holding
only that counts as having none.

**And every way this can be refused is an `AutomationNotConfiguredError`**,
which the route turns into a `409` with a code *and a sentence*. That is the
whole of the fix for a real bug: the OpenAI case used to throw an
`AiUnavailableError` past the refusal handler, Fastify answered
`{"statusCode":500,…}`, and the app printed "The hub answered 500." over a hub
that was working perfectly and had just said exactly what was wrong.

The **test seam** (`createConversation`) therefore sits *after* every one of
these checks. It stands in for the network, not for the rules — above them it
was a bypass that let the suite reach a conversation the real hub would have
refused, which is why the refusal shipped with no coverage at all.
