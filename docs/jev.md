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
  not billed. About **$0.00002 a decision**.
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

`AiVendor = AiProvider | 'typesafe'` is the second vocabulary — whose model
answers, which is what a key and a route are held for — and
`AiCredentialSlot = AiVendor | 'vercel'` the third, used only where a
*credential row* is meant (the gateway holds a key and answers nothing). Three
things must never change with them:

- flat `AiSettings.hasKey` stays the *generative* providers only — each one's
  own key, or the gateway's key for a provider routed through it — because
  `lazy.ts` and the API's `ai_not_configured` check both read it as "can an
  agent run at all", and a Jev key (or a gateway key routed for Jev alone)
  making it true would build a mapper that then fails at the provider;
- `mappingChoosable` stays both *generative* providers;
- `UsableProviders` keeps exactly two fields, which is what makes
  `effectiveAgentModel` structurally unable to select Jev.

---

## What a home switches, and what it does not

There is **no "Jev engine"**, and the settings say so. A home picks its LLM
exactly as it did before — provider and model, per agent — and runs the
ordinary loop on it. Jev is a step in *front* of that loop, and everything it
decides is something the loop would have done anyway.

So `GET`/`PATCH /settings/ai` carries three fields beside the existing ones,
under `decision`:

| Field | What it is |
|---|---|
| `hasKey` | whether TypeSafe's **own** key is stored (`typesafeApiKey` writes it, `clear: "typesafe"` forgets it) |
| `route` | whose key buys the decisions — `direct` (TypeSafe's) or `vercel` (the gateway's); `routes: {typesafe}` writes it |
| `usable` | whether there is a key on that route, so a decision can be asked at all |
| `enabled` | the owner's pause switch — `decisionsEnabled` writes it, and it defaults to **on** |

**`enabled` is deliberately not the credential**, the argument `ai_enabled`
already made one field up: "stop spending my money on this for now" and "forget
my key" have very different costs to undo. Off, every plain request still
happens; it just takes a model round, which is what the app's own copy says.

`model` is reported and never settable — see *Calibration* below for why that
is not a gap. **The route is not the key's**, which is the change the first cut
of this got wrong: forgetting TypeSafe's own key leaves a home that buys its
decisions through the gateway deciding exactly as it did, and forgetting the
*gateway's* key sends every vendor it carried back to its own key — Jev
included, which then stops if it has none.

---

## The architecture

```
src/ai/decide/
  decider.ts      the seam — no SDK, no vendor. Types, and the pinned model id.
  typesafe.ts     the only file that names TypeSafe's API. Plain fetch. Throws.
  lazy.ts         the Decider a caller holds: fail-open, priority, breaker.
  routes.ts       where the same model can be bought. Not a model list.
  questions.ts    every question and every threshold. The wording is the contract.
  home-command.ts reading one sentence against one home.
```

`decider.ts` is SDK-free *and* vendor-free — `agent-core.ts`'s rule with one
addition. `typesafe.ts` is the `voice/live-wire.ts` containment rule: the wire
lives in one file small enough to read in a sitting, because it is the one
thing here nobody can check by running the hub.

### `decide` never throws

`null` means "no answer" — a refusal, a timeout, an open breaker, or a request
dropped because one was already in flight. **Every caller falls back to the
path it had before.** A seam that threw would put a `try`/`catch` at every call
site instead of making fail-open a property of the type.

`DecisionResult.answers` is **optional per question**, on purpose: a 200 that
answered a subset is a real shape, and `answers.route!.choice` is how that
becomes `undefined` in somebody's kitchen.

### One at a time, and the asymmetry is the point

Concurrent requests queue at the vendor, so `lazy.ts` runs one at a time. Which
one gives way is `decide`'s `priority`, and it is **not symmetric**:

- a **speculative** call is dropped outright when anything is in flight;
- a **live** call *aborts* an in-flight speculative one and proceeds.

Without the second half the feature starves the thing it exists to help: a
speculation still in the air made the real turn's `decide` return `null`, so
speaking to a hub with this switched on was **slower** than speaking to one
without it. An aborted speculation arms nothing — nobody was waiting for it,
and a breaker armed by our own cancellation would silence the next real call.

### No retry, and why

The vendor's contract says back off on 429 and 529. As *policy* here that is
exactly wrong: these calls sit in front of somebody waiting, so a retry turns a
180 ms saving into a two-second regression. **One request, one short deadline,
then today's path.**

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

The hub deliberately **never calls `GET /v1/models`**: the model is ours to
pin, so a list to keep correct would be a second vendor surface for nothing.

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

### A route is not a model

The same model is sold in more than one place, so `routes.ts` is a table of
**addresses**, not of models:

| route | Base URL | Model id on the wire | Key |
|---|---|---|---|
| `direct` | `https://api.typesafe.ai` | `jev-1.13.0` | TypeSafe's own (`ts-…`) |
| `vercel` | `https://ai-gateway.vercel.sh/typesafe` | `typesafe-ai/jev` | the gateway's (`vck_…`) |

Vercel's AI Gateway serves a **TypeSafe-compatible** endpoint, so the body and
the native `noul`/`choice`/`score` answers are unchanged — only the host, the
key and the string that names the model differ. Deliberately **not** the AI
SDK's normalised `/v1/evaluate`, which renames `noul` to `probability` and
moves `confidence` into `providerMetadata`: reading that shape would mean a
second parser for the one file nobody can check by running the hub.

Everything above about pinning still holds, and this is why the distinction
has to be said out loud rather than left to be inferred from a switch: a route
changes **where the request goes and whose key pays**, and never what answers.
If a route ever served a different model, the thresholds below would silently
stop meaning what they say — so a route that did that would be a different
feature, not a new row in this table.

**The route is the same per-vendor setting Claude and OpenAI have**
(`src/ai/gateway.ts`, stored as `ai_route_typesafe`, absent meaning `direct`),
and the key comes from the route's own slot: TypeSafe's for `direct`, the
gateway's for `vercel`. It used to be a route stored beside the TypeSafe key,
so a home buying through Vercel held a *Vercel* key in the *TypeSafe* slot and
an app had to rename that row to stay truthful. One gateway key for every
vendor is the fix: each key is exactly what its slot says, and whether a vendor
goes through the gateway is a switch rather than a property of the key pasted
into its box. `SettingsService.adoptLegacyDecisionRoute` moves a key the first
cut left behind, once, at boot. `lazy.ts` asks `aiConnection('typesafe')`,
which answers the route and its key from one read, so the two can never come
from different moments.

Two consequences in code. The key-prefix checks are **negative** only: the
TypeSafe field refuses an `sk-ant-`/`sk-proj-` key and a gateway `vck_` key
(each certainly somebody else's), and asserts nothing about how TypeSafe's own
keys start. And the gateway's `keyPrefix` is a **placeholder and nothing
more**: it is in `GET /settings/ai` so an app can put `vck_…` in an empty field,
and it is not a positive check, because a vendor can change a prefix faster
than a hub can be updated — being wrong about a placeholder costs a moment's
confusion; being wrong about a guard costs somebody their key.

**And one diagnostic, because the failure mode here is silence.** `typesafe.ts`
drops an answer it cannot place — a `choice` with no `confidence`, a score off
the rubric — which is right, and would mean that a gateway omitting a field
left *every* fast path quietly never firing with nothing in the log. A response
whose answers are dropped is logged at `warn` with the route, the model and how
many were asked against how many were placed. That is the difference between
"measure it" and "find out".

---

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
| **Not a calculator.** Unreliable at counting and comparing numbers. | `needsValue` ends the attempt whenever the sentence names a quantity. No action in the vocabulary carries a number. |
| **Reads dates as text**, so ordering and windows are unreliable. | Nothing here asks about a time. Schedules go to the automations agent, which is a generative model. |
| **Reads literally**; double negatives degrade it. | `DelegateAgent.decisionCriterion` exists because `description` says "Not for switching something on now, and not for questions about a rule" — two negatives in one clause. Criteria are positive statements. |
| **Context rot** — accuracy falls as the state fills with irrelevant detail. | The state is the sentence and the catalog, nothing else. `MAX_DEVICE_OPTIONS` stands the fast path down on a home too big to offer. |
| **State is data, so injected instructions can move an answer.** | Every output is re-checked by a guard that already exists — see *Safety* below. |
| **No published multilingual evaluation.** | Unresolved, and worth knowing. A home that speaks Russian to the voice runs English instructions over a non-English state with no evidence either way, and the failure is silent. The skip-ahead-only design is what keeps being wrong cheap. There is no per-person locale on the hub to gate on. |

It also **cannot abstain** — it always answers — which is why every closed
question here carries a no-match option (`other`, `neither`, `none_of_these`).
Without one, an unrelated sentence is forced into the nearest box.

---

## What the hub asks it

One request, thirteen questions, on every typed assistant turn and every
spoken one. Modelled on TypeSafe's own smart-home demo.

| id | type | What it settles |
|---|---|---|
| `intent` | choice | device command · home question · automation work · app question · other |
| `multiple` | noul | more than one thing asked for |
| `needsValue` | noul | the sentence names a quantity |
| `scope` | choice | one device · a room · the whole home |
| `room` | choice | the home's own rooms, by id — a **cross-check**, see below |
| `device` | choice | the home's own devices, by id |
| `switchAction` `coveringAction` `lockAction` `playbackAction` | choice | **speculative branches**, each stating its own premise |
| `route` | choice | which agent should take it, built from the delegate registry |
| `selfContained` | noul | the sentence stands alone as a brief |
| `effort` | score | how much thinking the answer is worth |

The branches are answered blind and in parallel — none of them knows which one
applies — so each has to say "suppose this request is about…". **What settles
which one is read is the resolved device's capabilities**, not the sentence: a
lock is never "turned off", whatever it sounded like.

`room` is read as a **cross-check** rather than as a way of finding anything.
It and `device` are answered blind beside each other, so when both are
confident and they *disagree*, one of them is wrong and there is no way to tell
which — and standing down costs one comparison. This is the shape a catalog
gets wrong: in a home with three lights called *Ceiling light*, "turn the
kitchen light off" resolves to the bedroom by a name that matched better than
the room did. A device in no room, an unconfident answer and `none_of_these`
all abstain rather than object; none of those is disagreement.

### The three that fire on a finished sentence

| Consumer | Fires when | Falls back to |
|---|---|---|
| **Device command** | intent, scope, device and the branch action all clear `ACT_CONFIDENCE_MIN`, and `multiple`/`needsValue` are both low | the ordinary two rounds |
| **Delegate route** (typed only) | `route` is not `here`, clears the bar, and `selfContained` clears `POSITIVE_NOUL_MIN` | the ordinary round, where the model calls `delegate` itself |
| **Effort** | the score says the work is plainly small | the transport's own `medium` |

### And a fourth, on one still being said

While somebody is talking, `warmForSpeech` reads the partial sentence and
**keeps what it decided**. When the finished sentence arrives, the real turn
spends no request at all and acts on the reading that is already there.

**`startsWith` is the whole invalidation rule, and it is enough.**
`VoiceDelegation.question()` joins the utterances it has kept, so somebody who
carried on talking produces a *superset* of what was speculated on — a hit.
Every way the transcript can have moved underneath instead produces a string
that is not a superset: a new utterance opened, an earlier one retired because
the voice answered it, one dropped by the context bound. Each of those is a
miss, and a miss simply decides live, which is what the hub did before any of
this existed. The entry is consumed either way and expires after
`SPECULATION_REUSE_MS`, so a reading of one sentence can never answer the next.

The warm also opens the conversation, builds the transport and gathers the
state digest, which is where most of the wall-clock saving is. That part is
worth doing on its own — but it is **not** the justification for spending a
decision on a partial sentence. Keeping the answer is.

---

## Safety — the rules a new consumer must keep

1. **Nothing Jev returns may widen what is possible.** A command goes through
   `AssistantChat.control`, which is the path the model's own tool takes: same
   registry, same per-device serialisation, same `device.command` activity row
   named for the person. An agent key goes through `delegate`, which is where
   `access.can(memberId, agent.permission)` lives. **Jev never decides a
   permission.**
2. **Never a number.** It cannot count; `needsValue` is the guard and every
   action in the vocabulary is number-free.
3. **A speculative turn may never write.** `VoiceDelegationHost.warmForSpeech`
   is narrowed so it *cannot* reach the home — the narrowing is the mechanism,
   not the comment. "Turn the bedroom light on — no, off" is an ordinary thing
   to say. Reusing the answer does not weaken this: what is reused is a
   *reading*, and the write still happens on the real turn, after
   `session.delegation.created` says the sentence has finished, through
   `control` and past every guard.
4. **Confidence-gated, with a documented fallback.** Without a threshold and a
   road for below it, the probability is decoration.
5. **One device, for now.** `room` and `whole_home` fall through. The blast
   radius of a wrong answer is one device, which is the difference between a
   surprise and a house. Widening that wants measurement, not a default.

---

## What it costs us, and where that is recorded

**There is deliberately no `ai_runs` row per decision.** `RETAIN_RUNS` is 250
and pruned on write, so a row per decision would evict a fortnight of chat
pricing within minutes of somebody talking to their house — the mistake
`STATE_FLUSH_MS` and the activity log each exist to avoid.

A decision's cost lands on `ChatSession.decisionUsd` and is folded into the
delta row the turn writes. A decision that led to no turn settles on whatever
row the session writes last, because `sweep()` and `close()` already call
`record`. Folding a non-token charge into a run's `costUsd` is what
`estimateCostUsd` already does for a web search.

One consequence worth keeping: no row ever carries `provider: 'typesafe'`, so
`modelLabel` never meets a Jev id and needs no branch.

---

## Where it would be worth using next

Ideas, not commitments — each needs the same treatment: a closed answer space,
a threshold, a fallback, and a failure that costs nothing.

- **Room and whole-home commands.** The demo does them; we stand down. Wants
  measurement on a real home first.
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

Deliberately **not** on the list: anything with a number in it, anything that
decides whether something is allowed, and anything on the automations
runtime — `src/automations/` runs with no key and no network, and that stays
true.

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
