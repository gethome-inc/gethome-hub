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

## The architecture

```
src/ai/decide/
  decider.ts      the seam — no SDK, no vendor. Types, and the pinned model id.
  typesafe.ts     the only file that names TypeSafe's API. Plain fetch. Throws.
  lazy.ts         the Decider a caller holds: fail-open, single-flight, breaker.
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
| `room` | choice | the home's own rooms, by id |
| `device` | choice | the home's own devices, by id |
| `switchAction` `coveringAction` `lockAction` `playbackAction` | choice | **speculative branches**, each stating its own premise |
| `route` | choice | which agent should take it, built from the delegate registry |
| `selfContained` | noul | the sentence stands alone as a brief |
| `effort` | score | how much thinking the answer is worth |

The branches are answered blind and in parallel — none of them knows which one
applies — so each has to say "suppose this request is about…". **What settles
which one is read is the resolved device's capabilities**, not the sentence: a
lock is never "turned off", whatever it sounded like.

### The three consumers

| Consumer | Fires when | Falls back to |
|---|---|---|
| **Device command** | intent, scope, device and the branch action all clear `ACT_CONFIDENCE_MIN`, and `multiple`/`needsValue` are both low | the ordinary two rounds |
| **Delegate route** (typed only) | `route` is not `here`, clears the bar, and `selfContained` clears `POSITIVE_NOUL_MIN` | the ordinary round, where the model calls `delegate` itself |
| **Effort** | the score says the work is plainly small | the transport's own `medium` |

And one non-consumer: **voice speculation** warms the session, the transport
and the state digest while somebody is still talking. It buys no answer.

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
   to say.
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
