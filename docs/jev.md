# Jev — the decision model

Canonical for `src/ai/decide/`. The subsystem rules live in `src/ai/CLAUDE.md`;
this file is the *why*, the contract, and what to know before adding a consumer.

---

## What a System One model is

Jev is TypeSafe AI's first **System One model**, released 15 September 2026. It
is not a small language model and it is not a language model used carefully. It
returns **typed values and never text**.

You send a **state** (a string, or JSON) and a map of named **questions**. It
answers every one of them in a single parallel pass and hands back a value per
question with a calibrated probability. There is no prose, no reasoning, no
tool call and nothing to parse.

```jsonc
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <key>

{ "model": "jev-1.13.0",
  "state": "switch the kitchen light off",
  "questions": {
    "urgent":  { "type": "noul",   "instructions": "It needs doing now." },
    "room":    { "type": "choice", "instructions": "Which room?",
                 "criteria": { "kitchen": "The kitchen.", "hall": "The hall." } },
    "severity":{ "type": "score",  "instructions": "How bad is it?",
                 "criteria": ["Fine.", "Awkward.", "Broken."] } } }
→
{ "model": "jev-1.13.0",
  "answers": {
    "urgent": { "type": "noul", "noul": 0.91 },
    "room":   { "type": "choice", "choice": "kitchen",
                "probabilities": { "kitchen": 0.97, "hall": 0.03 }, "confidence": 0.96 },
    "severity": { "type": "score", "score": 1.4,
                  "probabilities": { "0": 0.1, "1": 0.5, "2": 0.4 }, "confidence": 0.6 } },
  "usage": { "input_tokens": 1840, "output_tokens": 27 } }
```

### The three primitives

| Type | Asks | Answers |
|---|---|---|
| `noul` | Does this hold? | `noul` — the probability of yes, 0–1. **No `confidence` field.** |
| `choice` | Which of these? | `choice` + `probabilities` per option + `confidence`. 2–255 options. |
| `score` | Where on this scale? | `score` (may land between levels) + `legend` + `probabilities` + `confidence`. 2–10 ordered levels. |

**A noul near 0.5 means "as likely as not", never "medium intensity".** Code
that reads `answer.confidence` on everything breaks on these — which is why
`NoulAnswer` in `decide/decider.ts` does not have the field to read.

### What it costs, and what it costs to ask more

- **$0.042 per million input tokens. Output is free** — reported in `usage` and
  not billed. A whole reading of a sentence against an ordinary home — every
  question, the catalog in the criteria — is a couple of thousand tokens:
  **well under a hundredth of a cent**.
- **100–400 ms**, and roughly **flat in the number of questions**. Concurrent
  *requests* queue behind one another.

Those two facts together are the whole design: **batch, never fan out.** A
second request costs more than doubling the questions in the first one. So
speculative questions — branches you may not read — are effectively free, and
asking them is the point rather than a waste.

---

## Why it is not an `AiProvider`

`AiProvider` is `'anthropic' | 'openai'` and stays two. `PRICING`,
`PROVIDER_MODELS` and `AGENT_MODELS` in `src/ai/models.ts` are all
`Record<AiProvider, …>`, so adding a third member fails the typecheck on
exactly the three tables a decision model must never be in. **That break is the
guard**, and `src/core/settings.ts` says so where somebody would try it.

If it were forced through, somebody would pick Jev as their assistant model and
get an assistant that cannot talk — a failure other integrators have shipped.

`AiCredentialSlot = AiProvider | 'typesafe'` is the second vocabulary, used
only where a *credential row* is meant. Three things must never change with it:

- flat `AiSettings.hasKey` stays `anthropic.hasKey || openai.hasKey` — `lazy.ts`
  and the API's `ai_not_configured` check both read it as "can an agent run at
  all", and a Jev key making it true would build a mapper that then fails at
  the provider;
- `mappingChoosable` stays both *generative* keys;
- `UsableProviders` keeps exactly two fields, which is what makes
  `effectiveAgentModel` structurally unable to select Jev.

---

## What a home switches, and what it does not

There is **no "Jev engine"**, and the settings say so. A home picks its LLM
exactly as it did before — provider and model, per agent — and runs the
ordinary loop on it. Jev is a step in *front* of that loop, and everything it
decides is something the loop would have done anyway.

So `GET`/`PATCH /settings/ai` carries four fields beside the existing ones,
under `decision`:

| Field | What it is |
|---|---|
| `hasKey` | whether TypeSafe's key is stored (`typesafeApiKey` writes it, `clear: "typesafe"` forgets it) |
| `enabled` | the owner's pause switch — `decisionsEnabled` writes it, and it defaults to **on** |
| `model` | the pinned model id, reported so an app can say what answered |
| `label` | the name a person reads — `Jev` — so the assistant's page can say **"Opus 5 + Jev"** in the hub's own words |

**`enabled` is deliberately not the credential**, the argument `ai_enabled`
already made one field up: "stop spending my money on this for now" and "forget
my key" have very different costs to undo. Off, every plain request still
happens; it just takes a model round, which is what the app's own copy says.

`model` is reported and never settable — see *Calibration* below for why that
is not a gap. `label` is `DECISION_MODEL_LABEL`, beside the id in
`decide/decider.ts`; the apps draw it after the assistant's model whenever a
key is stored and not paused, because the next thing said is then read by one
model and answered by the other.

---

## The architecture

```
src/ai/decide/
  decider.ts      the seam — no SDK, no vendor. Types, and the pinned model id and label.
  typesafe.ts     the only file that names TypeSafe's API. Throws.
  connection.ts   the kept-alive connection it rides on, and the warm-up.
  lazy.ts         the Decider a caller holds: fail-open, priority, breaker.
  questions.ts    every question and every threshold. The wording is the contract.
  home-command.ts reading a sentence against one home: a plan, a split, a route —
                  or why it did nothing.
  split.ts        the one step that writes: a compound sentence into its parts,
                  on the home's own generative model.
```

`decider.ts` is SDK-free *and* vendor-free — `agent-core.ts`'s rule with one
addition. `typesafe.ts` is the `voice/live-wire.ts` containment rule: the wire
lives in one file small enough to read in a sitting, because it is the one
thing here nobody can check by running the hub.

### `decide` never throws

`null` means "no answer" — a refusal, a timeout, an open breaker, or a
speculation dropped because something was already in flight. **Every caller
falls back to the path it had before.** A seam that threw would put a
`try`/`catch` at every call site instead of making fail-open a property of the
type.

**And it says which.** `onMiss` is told `off`, `busy`, `resting`, `timeout` or
`failed` (`DecisionMiss`), and whether the request had to open a connection
first — for a log line and a trail step, **never for a branch**: every miss
falls back identically, so the contract is still `null` and a decider that
never calls it is still correct. A timeout is its own error
(`DecisionTimeoutError`, read by name) rather than the `AbortError` the
watchdog causes, because "too slow" and "the connection went away" are
different lines.

`DecisionResult.answers` is **optional per question**, on purpose: a 200 that
answered a subset is a real shape, and `answers.route!.choice` is how that
becomes `undefined` in somebody's kitchen.

### The connection was most of the latency

**A decision is about a fifth of a second of work behind a handshake that cost
more than that.** Node's global `fetch` keeps an idle connection for about four
seconds and then closes it, so nearly every sentence arrived to a closed
connection: DNS, TCP and TLS from a Raspberry Pi to the vendor, two or three
round trips before the question was even sent. From a home a few thousand
kilometres away that is most of a 700 ms deadline — and it is what a real hub's
`Jev stood down — didn't answer in time (nothing back within 700 ms)` turned
out to be: not the model being slow, the hub dialling it from scratch every
time, so "turn off the light" took a whole model round anyway.

Three changes, each on its own too small to be the fix:

- **A kept-alive connection** (`connection.ts`): `node:https` with an agent of
  its own, idle sockets kept for `IDLE_MS` (minutes, not seconds) with TCP
  keep-alive probes so a home router's NAT table does not forget them, and the
  server's own `Keep-Alive: timeout=` hint still honoured when it is shorter.
  **No dependency** — `undici` is not in the tree, and the built-in agent does
  the one thing needed. A socket the far end let go of while it sat idle is not
  a failure: the request never reached anybody, so it is sent once more on a
  fresh connection (`req.reusedSocket`, the documented pattern) — only then,
  and only once. It hands back a real `Response`, so `typesafe.ts` parses a
  reply the same way whatever carried it, and a test can stand a stub in with
  nothing about the parsing changing.
- **A warm-up** (`Decider.warm`, `AssistantChat.prepare`): opening the
  assistant's page (`GET /assistant/chats`, which the page reads the moment it
  appears) and starting a voice session both open the connection while
  somebody is still reading or about to talk. The request is `GET /v1/models` —
  the cheapest authenticated request there is, whose answer nothing reads; the
  model is still pinned. It does nothing without a key, while paused, while the
  breaker rests, when a connection is already open or while a decision is out,
  and it never throws: a warm-up that failed costs exactly the cold start it
  was trying to save.
- **A realistic deadline**: `DECISION_TIMEOUT_MS` is 1500 ms rather than 700.
  Still a deadline and not a retry budget, and still well inside what it saves —
  the ordinary path for a command is a whole model round to call the tool
  before the round that says it happened.

Every reading and every miss says whether it had to dial first
(`newConnection`), which is the first question anybody asks of a log line that
says 212 ms or 1400 ms.

### A guess gives way; the real thing never does

Which request gives way is `decide`'s `priority`, and it is **not symmetric**:

- a **speculative** call — a reading of a sentence still being said — is
  dropped outright while anything is in flight, never queued, because a queued
  guess arrives after the sentence it was guessing about;
- a **live** call always goes, beside whatever is out, and **nothing in flight
  is ever aborted.**

The first version ran one request at a time and had a live call abort an
in-flight speculation. Aborting a request mid-flight destroys the connection
under it, so the live call it was making room for then paid for a fresh
handshake — the exact cost the connection exists to avoid. Two requests at once
cost a second socket (`MAX_SOCKETS` bounds them) and nothing else.

### No retry, and why

The vendor's contract says back off on 429 and 529. As *policy* here that is
exactly wrong: these calls sit in front of somebody waiting, so a retry turns a
180 ms saving into a two-second regression. **One request, one deadline, then
today's path.** (The stale-socket resend above is not a retry: that request was
never delivered.)

What replaces it is a **breaker** keyed on `sha256(secret)`: after three
consecutive failures it stops calling for a minute, and saving a new key
retires it. That is what makes an outage cost *zero milliseconds* rather than
merely no error — "invisible" has to mean no added latency.

A **422 is our own malformed question** and comes back `null` without arming
anything, so a bug the hub just shipped cannot hide behind a timer.

### The client makes the types true

A `choice` outside the criteria, a score off the end of the rubric, a noul
outside 0–1: that answer is **dropped, never coerced**. The type says the
answer space is closed; `readAnswer` is what enforces it. An oversized state is
**refused, never truncated** — a cut state produces a confident answer to a
different question.

---

## Calibration, and why the model is pinned

Jev is trained with **RLCD** (Reinforcement Learning for Calibrated Decisions):
the goal is that the probabilities track outcomes, rather than that the answer
reads well. Over many predictions at 0.8, about 80% should be right.

Two things follow that are easy to get wrong:

- **`confidence` is not the probability of being correct.** On `choice` and
  `score` it measures how concentrated the distribution is. Two genuinely good
  options spread it without anything being wrong.
- **Thresholds do not transfer between models.** A published integration swept
  its own labelled data and landed on **0.85** where 0.5 looked natural. So the
  model is a build constant (`DECISION_MODEL`), not a setting: a settable model
  would silently invalidate every number in `questions.ts`. This is the
  `src/portraits/CLAUDE.md` pinned-image-model argument.

**Every threshold in this repository is assumed, not measured**, and
`questions.ts` says so beside each one. They are the first thing to re-sweep
against a real home.

One that is worth knowing about: **a noul on this model has a floor.** On
records that are plainly clean it still answers 0.2–0.5 where a generative
model would say 0.0. So `NEGATIVE_NOUL_MAX` is 0.4 rather than 0.15 — a gate
near zero would refuse everything, and the feature would silently never fire.

---

## What it is bad at

From TypeSafe's own jaggedness page, and each one is designed around here:

| Weakness | What we do about it |
|---|---|
| **Not a calculator.** Unreliable at counting and comparing numbers. | **It never reads a number.** Code finds the one number in a sentence (`amountIn` — exactly one, digits only, bounded so "2026" and "lamp2" are not numbers) and puts it in the state as its own field; the model is asked only what it is a number *of* — a brightness, a temperature, a fan speed, a time, part of a name. The range check, the unit and every calculation after that are code. Two numbers, or one spelled as words, and the reading needs a number it does not have: it stands down. The vendor's pre-parsed extraction pattern. |
| **Reads dates as text**, so ordering and windows are unreliable. | Nothing here asks about a time. `later` stands the fast path down on any delay, time or condition, and schedules go to the automations agent, which is a generative model. |
| **Reads literally**; double negatives degrade it. | Criteria are positive statements, and every `unchanged` carries an example of the sentence that should choose it. `DelegateAgent.decisionCriterion` exists because `description` says "Not for switching something on now, and not for questions about a rule" — two negatives in one clause. `negated` stands down on "don't", "never mind" and "on — no, off". |
| **Context rot** — accuracy falls as the state fills with irrelevant detail. | The state is the sentence (or the parts it was split into) and the one number, nothing else; the rooms and devices are the *criteria* of their own questions. `MAX_DEVICE_OPTIONS` stands the fast path down on a home too big to offer. |
| **State is data, so injected instructions can move an answer.** | Every output is re-checked by a guard that already exists — see *Safety* below. |
| **No published multilingual evaluation.** | Unresolved, and worth knowing. A home that speaks Russian to the voice runs English instructions over a non-English state with no evidence either way, and the failure is silent. The skip-ahead-only design is what keeps being wrong cheap: an unsure reading is the ordinary round. There is no per-person locale on the hub to gate on. |

It also **cannot abstain** — it always answers — which is why every closed
question here carries a way out (`other`, `none`, `none_of_these`,
`not_said`, `unchanged`). Without one, an unrelated sentence is forced into
the nearest box.

---

## What the hub asks it

**One request per sentence, every question in it** — the vendor's speculative
fan-out, and its own smart-home demo step for step. About twenty questions, on
every typed assistant turn and every spoken one:

| id | type | What it settles |
|---|---|---|
| `intent` | choice | device command · home question · scene · automation work · app question · other |
| `multiple` | noul | more than one separate request — with criteria, because "all the lights" is **one** |
| `anyCommand` | noul | at least part of it is a command, so a split can save something |
| `later` | noul | a delay, a time, a length of time or a condition — a guard |
| `negated` | noul | "don't", "never mind", "on — no, off" — a guard |
| `scope` | choice | one device · several named one by one · a group · none |
| `place` | choice | the home's rooms (`r1`…) and zones (`z1`…), the whole home, or no place |
| `deviceType` | choice | what a group is made of: lights, plugs, blinds, locks, TVs and speakers, fans, climate, everything |
| `device` | choice | the home's devices (`d1`…), each described by name, kind and room |
| `power` `brightness` `colour` `cover` `lock` `playback` `climate` `fan` | choice | **speculative families**, each stating its own premise and each with `unchanged` |
| `amount` | choice | what the one number in the sentence is of — asked only when there is exactly one |
| `route` | choice | which agent should take it, built from the delegate registry |
| `selfContained` | noul | the sentence stands alone as a brief |
| `effort` | score | how much thinking the answer is worth |

**Keys are short and plain — `d1`, `r1`, `z1` — and the name is in the
description.** A key is what comes back, so it has to survive the wire whatever
somebody called their kitchen: a name in Cyrillic, with quotes or emoji in it,
or shared with another room. They used to be the devices' UUIDs, forty tokens
of noise per option in front of the one thing that mattered.

The families are answered blind and in parallel — none of them knows which
kind of device the request turned out to be about — so each says "suppose
`said` is about…". **What settles which one is read is the resolved device's
capabilities**, not the sentence: a family is only consulted for a device that
has its capability, so "turn off the TV" read under the heating's premise says
"off", and that answer never reaches a thermostat. A lock is never "turned
off".

`place` does two jobs. For a group it says where the group is. For one device
it is a **cross-check**: it and `device` are answered blind beside each other,
so when both are confident and they *disagree*, one of them is wrong and there
is no way to tell which — and standing down costs one comparison. This is the
shape a catalog gets wrong: in a home with three lights called *Ceiling light*,
"turn the kitchen light off" resolves to the bedroom by a name that matched
better than the room did. A device in no room, an unconfident place, the whole
home and no place at all abstain rather than object; a zone agrees with every
room in it.

### What a reading turns into

| Road | When | What happens | Falls back to |
|---|---|---|---|
| **Act — one device** | intent, scope, device and every family the device reads clear `ACT_CONFIDENCE_MIN`; `later`, `negated` and `multiple` are clear noes | carried out before the model is asked | the ordinary round |
| **Act — a group** | the same, with `scope: group`, a place and a kind — every device of one kind in a room, a zone or the house | carried out device by device, a few at a time | the ordinary round |
| **Split** | `anyCommand` and `multiple` both reach `SPLIT_NOUL_MIN`, or two devices were named one by one | the conversation's model splits it, the parts are read in **one** more request, and every part read confidently is carried out | the ordinary round over the whole sentence |
| **Route** (typed only) | `route` is not `here`, clears the bar, and `selfContained` clears `POSITIVE_NOUL_MIN` | handed to that agent in the person's own words, with no round of the assistant's | the ordinary round, where the model calls `delegate` itself |
| **Effort** | the score says the work is plainly small | the round runs at `low` | the transport's own `medium` |

A sentence that is neither clearly one request nor clearly several — `multiple`
between `NEGATIVE_NOUL_MAX` and `SPLIT_NOUL_MIN` — is neither split nor acted
on: the model reads it whole.

**Every number is worked out in code.** 40% is `round(0.4 × 254)`; "brighter"
is a quarter of the range from the level the light reports now, and stands down
when that is not known; a named white is held inside the light's own mired
range; a temperature must be a room temperature (5–35°) *and* inside the
device's own setpoint limits, and moves the cooling setpoint while it is
cooling; "faster" steps a fan's mode while it is on one of its three speeds and
its percentage otherwise. Brightness and colour on a light that is off switch
it on first — "make it red" means a red light — but "dim it" does not. **Off
wins**: switched off is the whole request, whatever else the families said.

### A group is read narrowly, and that is a safety rule rather than a gap

- **"Everything" is what a person switches off leaving a room** — lights,
  switches, TVs, speakers, fans. A plug, an appliance, a lock or the heating is
  only moved when it is named for what it is ("the plugs in the kitchen"),
  because the fridge is on a plug. Everything may be switched off or paused, and
  switched on in one room, but **never switched on across the whole home**.
- **A group of locks is never unlocked.** Locking every door is the thing
  somebody asks when they leave; unlocking every door is a misreading with a
  front door at the end of it, and the model can ask.
- **No place said is the whole home — for switching off, and only then.**
  "Turn off the lights" (or "выключи свет") said to a phone has nowhere else it
  could mean: the hub does not know which room the person is in, and the
  assistants people already use read it as every light in the house. Off is
  also the direction that is safe to get wrong, so an unplaced group acts on the
  whole home when every command it would send switches off, pauses or locks
  (`switchesOff`), and stands down otherwise: "turn on the lights", with every
  lamp in every bedroom at the end of it, is the model's to read or to ask
  about. "*All* the lights" is the whole home in either direction, and says so
  in the question.
- **A member the action does not apply to is left alone** — a light that
  cannot dim, in "dim the lights" — and **a member the hub knows is offline is
  not tried**: a command to a device that cannot hear it is at best an error
  and at worst a Matter node holding the command through every retransmission,
  and one bulb in a hallway must not keep the house waiting for the sentence
  that says the lights are off. It is named in the account the model is given,
  so the reply can say which one did not go off. Every member offline, and it
  stands down.
- **`MAX_COMMANDS` (24) bounds one request.** A reading that resolves to more
  is a place misheard as the whole house.
- **A two-gang switch named on its own stands down** ("which half?" is the
  model's to ask); in a group, every endpoint is worked.

### Several requests in one sentence

The one step here that writes. When Jev says a sentence holds several requests
and at least one is a command, `split.ts` asks the **conversation's own model,
on the home's own key**, to rewrite it as a list — the owner chose that model
and pays for it, and a second vendor or a model nobody picked would be a cost
the settings page never mentions. It runs at the lowest effort with no
thinking, under a JSON schema (structured output on both vendors, never prose
to be parsed), one deadline (`SPLIT_TIMEOUT_MS`) and no retry; the parts are
checked again here — one to `MAX_PARTS`, none empty, none long — and refused
rather than repaired. The prompt is about fidelity: their words and their
language, the verb and the place carried across so "the hall one" becomes
"turn off the hall light", nothing added, nothing dropped, nothing answered, and
a group kept whole, so it and `multiple` cannot disagree about "all the lights
in the kitchen".

The parts then go back to Jev in **one** request (`decideParts`): the state is
the list, and every question points at its own part by path (`parts[1]`,
`amounts[1]`) — the vendor's advice for several questions with similar
instructions. Each part must clear every bar a sentence does, and is asked
`multiple` again as a guard: a part that is still several requests is the
model's. A part it is sure of is carried out; anything else — a question, a
rule, a part it was unsure of — is left for the model, quoted, beside the
sentence as it was said.

A split that fails, that comes back as one part, or in which nothing could be
carried out sends the sentence to the ordinary round whole — the hub before any
of this. So "turn off the TV and close the blinds" is two commands carried out
before the model has been asked anything, and "turn off the light and what's
the temperature?" is one command carried out and one question left for the
model to answer.

### What the model is told

Whatever was carried out, **the model writes the reply** — a canned "All done"
is words in its mouth, the rule the automations agent's own prose arm is built
around. It is told exactly what happened (`fastPathPriming`, on
`ChatSession.priming`, so it reaches the model and never the transcript): every
device by name and room, what was done to it **in words** ("switched on and set
to 40% brightness", never a command type), which did not take it and the
adapter's own reason, which were offline and not tried, and — for a split
sentence — the requests that were **not** carried out, quoted, as its to handle.
It is told not to do any of it again and that there is no need to check it with
`get_device`; out loud, that the digest above was read a moment before.

When nothing is left for it, the round runs at the lowest effort: the work is
finished, and what is left is a sentence. When a part is left, the round is the
ordinary one.

**A prompt is a request rather than a guarantee**, so `control` keeps a record
of what this turn carried out and drops a repeat of the same command on the
same endpoint — the model calling the tool anyway is a no-op rather than a lamp
that flickers. A command the device *refused* is not in that record: it was
never carried out, so asking again is a real second try.

### The fast path never throws

`beforeRound` is a seam that must answer, and a throw out of it is not a
fallback: `exchange` catches it as a turn that could not be saved, writes a
note and runs no round at all. So everything the fast path does sits under one
`catch` whose answer is the model's sentence, whole. Whatever was already
carried out stays carried out, and the once-per-turn record makes the model's
own call for it a no-op. For the same reason a command's **activity row** is
written without being allowed to fail the command: the device has taken it by
then, and a row that could not be written once told the model — and so the
person — that a light which had just gone off had not.

### And on a sentence still being said

While somebody is talking, `warmForSpeech` reads the partial sentence and
**keeps what it decided**. When the finished sentence arrives and is **the same
sentence** — case, punctuation and spacing aside (`sameSentence`) — the real
turn spends no request at all and acts on the reading already there. The voice
asks for help a beat after somebody stops, so the last partial read is usually
the whole of what they said.

**Equality, never a prefix.** The rule used to be `startsWith`, on the
reasoning that carrying on talking produces a superset of what was read — and a
superset is exactly where the meaning changes: "turn the bedroom light on" read
while somebody was still saying "— no, off" would have been acted on as *on*,
and "turn off the kitchen light" read before "and the hall light" would have
moved one light of two. Anything but the same sentence decides live, on the
connection the speculation left open. The entry is consumed either way and
expires after `SPECULATION_REUSE_MS`, so a reading of one sentence can never
answer the next.

A finished sentence arriving while its speculation is **still out** waits for
it briefly (`SPECULATION_WAIT_MS`): it holds the one open connection and may
have read exactly this sentence, so a short wait is usually faster than a
second request beside it — and the bound keeps a slow speculation from becoming
the wait.

The warm also opens the conversation, builds the transport and gathers the
state digest, which is where most of the wall-clock saving is. That part is
worth doing on its own — but it is **not** the justification for spending a
decision on a partial sentence. Keeping the answer is.

---

## What it says it did, and why it did nothing

**Every road it takes is a step in the trail and a line in the log**, so
`grep Jev` over the hub's journal tells the whole story of a home:

| What happened | Trail step (`kind`) | Log line |
|---|---|---|
| carried out | *Jev switched off 2 lights in the Kitchen* (`routing`), with the reading's time, a new connection if it dialled, the confidence, and anything that failed or was offline | `Jev carried out — switched off 2 lights in the Kitchen` |
| split | *Jev heard 2 requests* (`routing`), over the quoted parts and how long the split took, then a step per part carried out | per part |
| handed over | *Jev passed this to the Automations agent* (`routing`) | — |
| stood down | the reason (`deferred`), when somebody could have expected the other road | `Jev stood down — …` |

Every `none` carries a `StandDown`: the question that settled it, what it
answered — by id and in words — the number it was measured by, the bar that
number had to clear, and the runner-up when the distribution was split (an
unsure answer is usually two answers, and naming the second is what turns
`0.41` into a reason). **A stand-down used to leave no trace.** The round that
follows one is exactly the round a hub with no key runs, so four seconds for a
light looked the same whether Jev was off, timed out, or was 0.41 sure between
two lamps — and "why not Jev?" meant replaying the sentence by hand.

`AssistantChat` writes it down on every turn, and `describeStandDown` decides
who hears it:

| Audience | When | Where it goes |
|---|---|---|
| `quiet` | Jev is off, or the home has no devices | a `debug` line |
| `logged` | read confidently as not a device command (`declined`) | an `info` line |
| `shown` | everything else — unsure, blocked, unanswered, disagreed, too big, timed out, failed, resting, busy, a split that could not be had | an `info` line **and** a trail step |

The line reads `Jev stood down — wasn't sure which device (TV light or
Ceiling light: 0.41, needs 0.85 · 212 ms)`, with the whole `StandDown` beside
it as `jev` — the vendor's `requestId` included, so a reading can be traced —
plus `via`, the session and `reused` when the reading was a speculation's
(whose timing is then the speculation's, not the turn's). A part of a split
sentence says which part (`for “what's the time”`). So
`journalctl -u gethome-hubd | grep 'Jev stood down'` is the whole of "why not
Jev?" for a home, and the first thing to read before re-sweeping a threshold.

The stand-down step is `kind: 'deferred'`, in the place `routing` would have
taken — the same act, not taken — with the phrase as its text and the numbers
as its detail. Two things are deliberate. **The model is not told about a
stand-down**: what it would do with the fact is apologise for it, and the reply
is its to write. And **a question is not a stand-down anybody sees**: most of
what people say to an assistant is not a device command, and a step on every
one of those turns would bury the one that matters. Speculative readings of a
sentence still being said log nothing; the one that is kept is reported by the
turn that uses it.

---

## Safety — the rules a new consumer must keep

1. **Nothing Jev returns may widen what is possible.** A command goes through
   `AssistantChat.control`, which is the path the model's own tool takes: same
   registry, same per-device serialisation, same `device.command` activity row
   named for the person. An agent key goes through `delegate`, which is where
   `access.can(memberId, agent.permission)` lives. **Jev never decides a
   permission.**
2. **It never reads a number.** Code finds it, the model says what it is *of*,
   and code does every calculation and every range check after that.
3. **A speculative turn may never write.** `VoiceDelegationHost.warmForSpeech`
   is narrowed so it *cannot* reach the home — the narrowing is the mechanism,
   not the comment. "Turn the bedroom light on — no, off" is an ordinary thing
   to say. Reusing the answer does not weaken this: what is reused is a
   *reading* of the same sentence, and the write still happens on the real
   turn, after `session.delegation.created` says the sentence has finished,
   through `control` and past every guard.
4. **Confidence-gated, with a documented fallback.** Without a threshold and a
   road for below it, the probability is decoration. A plan's confidence is the
   **weakest link** of the answers it rests on — the function-calling
   cookbook's rule: one wrong argument spoils the call.
5. **A group is bounded and read narrowly** — see *A group is read narrowly*
   above. Widening "everything", or letting a group unlock, wants measurement
   on real homes, not a default.
6. **The one step that writes is checked, never trusted.** A split is read back
   by Jev part by part against every bar a sentence has to clear, and a split
   in a shape the hub will not read is the sentence, whole.

---

## What it costs us, and where that is recorded

**There is deliberately no `ai_runs` row per decision.** `RETAIN_RUNS` is 250
and pruned on write, so a row per decision would evict a fortnight of chat
pricing within minutes of somebody talking to their house — the mistake
`STATE_FLUSH_MS` and the activity log each exist to avoid.

A decision's cost — and a split's, which is a few hundred tokens on the home's
own model — lands on `ChatSession.decisionUsd` and is folded into the delta row
the turn writes. A decision that led to no turn settles on whatever row the
session writes last, because `sweep()` and `close()` already call `record`.
Folding a non-token charge into a run's `costUsd` is what `estimateCostUsd`
already does for a web search.

One consequence worth keeping: no row ever carries `provider: 'typesafe'`, so
`modelLabel` never meets a Jev id and needs no branch.

---

## Where it would be worth using next

Ideas, not commitments — each needs the same treatment: a closed answer space,
a threshold, a fallback, and a failure that costs nothing.

- **Scenes by name.** `intent` already recognises one; a choice over the home's
  pressable rules would let "movie night" run with no round at all.
- **Calibrating on our own traffic.** Fold a decision's question ids, answers
  and confidences onto the turn's `assist` run as `ai_run_exchanges` rows,
  gated on the existing `recordExchanges` switch — whose documented job is
  exactly "suspend that rule while something is being worked out". That turns
  threshold-sweeping into something an owner can do on their own home.
- **A mapping pre-gate.** "Is this exposes tree already fully placed by layers
  1–2?" is a judgement a decision model could make before a paid run starts.
- **Reranking documentation** for the mapper's `fetch_page`, so a run reads the
  page that answers rather than the first that matched.
- **Guardrails on the assistant's own input** — one noul battery, thresholds
  ours rather than baked into somebody's weights.

Deliberately **not** on the list: anything that asks it for a value rather
than a choice, anything that decides whether something is allowed, and
anything on the automations runtime — `src/automations/` runs with no key and
no network, and that stays true.

---

## Working on this

TypeSafe publish an agent skill for designing System One workflows. It is
vendored at `.claude/skills/typesafe-ai/` (MIT) so it works offline and is
versioned with this repository. It tells an agent to read the live docs, which
is where the current detail is.

To take it from upstream instead, so it stays fresh:

```sh
claude plugin marketplace add typesafe-ai/skills
claude plugin install typesafe@typesafe-ai
```

### Links

- Docs index: <https://docs.typesafe.ai/llms.txt> — **append `.md` to any docs
  path** for Markdown, e.g. `/concepts/system-one.md`.
- [System One](https://docs.typesafe.ai/concepts/system-one) ·
  [How to build with it](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)
- [Primitives](https://docs.typesafe.ai/primitives) ·
  [Confidence](https://docs.typesafe.ai/confidence)
- [Speculative fan-out](https://docs.typesafe.ai/patterns/fan-out) ·
  [Function calling](https://docs.typesafe.ai/cookbooks/function_calling)
- [Smart-home demo](https://docs.typesafe.ai/demos/smart-home) — the shape this
  is built on, with its decision trace visible.
- [What Jev is bad at](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
- [HTTP API](https://docs.typesafe.ai/api)
