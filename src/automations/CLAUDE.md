# `src/automations/` — rules a home runs by itself

Loaded when Claude works with files under `src/automations/`. The root
`CLAUDE.md` carries the two rules from here that bind code outside this
directory. `docs/automations.md` is canonical — update it in the same change.

- **Automations are data the hub interprets, and the guards are not
  negotiable.** `src/automations/` is the rules a home runs by itself, and a
  **scene is an automation with a `manual` trigger** — one object, one store,
  one vocabulary, because "press this and the house does that" is not a second
  system. `docs/automations.md` is canonical.
  **The document is `MappingDescriptor`'s rule again**, and for five reasons
  rather than one: the service account can read `hub-secret.json`, the token
  hashes and `<data>/update/` (a write there starts a root unit); there is no
  compiler in the bundle; a rule has to be rendered to a person in their own
  language; a rule has to be checkable before it runs; and a rule outlives the
  build that wrote it, so `version` is **defaulted** (the `z.literal(1)` bill
  came due once already) and a document this build cannot parse is kept,
  reported and **not run** rather than silently missing a step.
  **A target is a selector, not only a list of ids** — "every light in the
  Kitchen". It is the request people actually make, it survives a lamp being
  paired next month, and it is the only way a template authored before it meets
  a home can install into one. The resolver also picks the endpoint carrying
  the capability the command needs, so a two-gang switch does the obvious thing
  without the author knowing it has two endpoints. Reachability is deliberately
  **not** a filter: a command to a sleeping battery device is queued by the
  protocol, and dropping unreachable devices would un-target half a home of
  sensors and make a rule mean different things at different times.
  **A `deviceState` trigger fires on the crossing**, never on every report
  while the test still holds — a battery at 12% reports hourly and would
  announce itself hourly for a month. The first evaluation of a pair *adopts*
  the answer and says nothing, which is `REACHABILITY_QUIET_MS`'s judgement
  applied to rules; and because the engine only sees a device when it
  **changes**, triggers have to be **primed against the home as it is** on
  every load, or the first change ever observed is mistaken for first sight and
  swallowed. That one cost a motion rule the first person to walk past it, on
  every boot.
  **A threshold on a continuously-varying reading is refused without `for` or
  `hysteresis`.** This is `STATE_FLUSH_MS` pointed at a relay instead of an SD
  card, and it is the rule the schema cannot express, so `sanity.ts` holds it.
  The two are not interchangeable: `for` suppresses a spike, `hysteresis`
  suppresses a value resting *on* the threshold and dithering across it, which
  an edge does nothing about because every wobble is a real edge. Actuator
  positions are deliberately not continuous — `level.current` moves because
  somebody moved it.
  **Five guards, and they apply to automation-driven commands only.** A person
  tapping a card quickly is a person; software tapping quickly is a bug, and
  that distinction is the whole reason the limits can be this tight.
  Idempotence first (one comparison against the registry's cache, and it
  absorbs most flapping); a two-second floor per endpoint, because a relay
  rated for 100 000 operations switched once a second is dead in a day and a
  half; hourly and daily budgets per device; causation with a depth cap; and a
  circuit breaker that switches a runaway rule off, writes `disabled_reason`
  and puts one line in the activity log. **Attribution is recorded *before* the
  write**: Zigbee2MQTT publishes optimistically, so a mains device can report
  its new state before `execute` resolves, and with the record afterwards
  `causeOf` answered "nobody" for exactly the reports our own commands caused —
  every link of a loop restarted at depth 0 and no chain could be cut. Three
  commands are never idempotent (`toggle` is defined by what it does,
  `stopCovering` is an interrupt, `irSend` has no state behind it), and a value
  never reported always sends: silence is not evidence.
  **The clock is injected and nothing is made up.** The tick fires for the
  minute it is *in*, so a schedule missed while the hub was down does not fire
  late; everything is held while the clock is implausible, because a Pi has no
  RTC and boots into a fictional time NTP corrects seconds later; an `interval`
  arms on the first tick rather than firing, since a restart is not an interval
  elapsing. A `wait` does not survive a restart and is capped at fifteen
  minutes to say so. `tick()` is public for the reason `HistoryService.flush()`
  is — a scheduler that reads `Date.now()` can only be tested by waiting.
  **Only a manual run reaches the activity log**, which is the log's own rule
  (what was *asked*, never what was reported): a motion rule's forty daily
  firings would drown a feed bounded at 5 000 rows. Traces live in
  `automation_runs`, bounded **per rule** — a global cap lets one chatty rule
  evict every trace of a quiet one — and they record the commands a guard
  *refused*, since "nothing happened" and "the hub declined to switch that
  relay for the fortieth time this hour" look identical from outside. The one
  automatic firing that does get a row is the breaker switching a rule off,
  because somebody has to find that a week later.
  **`enabled` and `active` are two words with two permissions.** `enabled` is
  whether the rule exists and is listening → `automation.manage`; `active` is
  whether a mode is switched on right now → **the floor**, because pressing
  "Night" switches lights and working the home is what being a member means.
  And a new rule is created **switched off** whatever the caller asks, because
  the moment between "here is what I wrote for you" and "your house is now
  doing it" is the only one in which somebody can still look.
  **What a rule is *called* is not what it does**, so `name` and `icon` ride on
  `PATCH /automations/:id` beside `document` — the apps hold the `summary`
  rather than the structure, and making them send a whole rule back to fix a
  typo would mean every app carrying a second copy of the DSL. Three rules, and
  the first is the one that bites: **a rename writes `document.name` too**,
  because `AutomationStore.update` sets the column *from* the document, so a
  rename that touched only the column would be undone by the next edit made in
  conversation — and the agent reads the document, so it would go on using a
  name nobody in the home uses any more. It **spends no version** (ten are kept
  per rule to walk back out of a bad afternoon, and the behaviour is untouched),
  and a rename is **logged** where a restyle is not — the rooms rule, since the
  feed is read a week later and "somebody changed that rule's icon" is not what
  anybody is looking for in it. `icon` is an opaque app token, null meaning
  "the app derives one" from the name and the shape, unvalidated here for the
  reason a room's is: an allowlist would need a hub upgrade for every mark an
  app adds.
  **Where a rule happens is derived, never stored** (`scope.ts`): every rule on
  the wire carries `roomId`, the one room every device it touches sits in, or
  null for a rule about the whole house — which is what lets an app put a rule
  on the page of the room it belongs to. A rule's room is a function of the
  document *and of the home right now* (a selector picks up a lamp paired next
  month; a device moved between rooms changes the answer with the rule
  untouched), so a column would be a second copy going stale in the dark; it is
  computed per read beside `summary` and costs what that costs. Four rules.
  **A selector naming a room declares one** whether or not anything is in it
  yet — "every light in the Kitchen" is the Kitchen's rule the day it is
  written, and everything such a target resolves to is in that room by
  construction. **What a rule watches counts**, not only what it does: the walk
  covers triggers, conditions (nested, since `all`/`any`/`not` hold more of
  them), actions and a toggle's off-actions, because a rule watching the
  Kitchen and switching the Hall is not the Kitchen's. **Touching a device
  nobody has placed disqualifies it** — the "not in a room" bucket is somewhere
  nobody has said, and the rule becomes the room's the moment that device is
  placed. And **`runAutomation` is not followed**: that rule has its own room
  and its own page. The half a client has to know is that **`roomId` moves
  without an `automation` frame**, because nothing about the automation
  changed — so an app re-reads on structure, not only on rules.
  **A rule is also sent as a picture** (`outline.ts`): the same document as four
  lists of display-ready steps — when, only if, then, and a toggle's off-branch
  — so an app can *draw* a rule instead of printing the sentence. It is the
  `message`/`data` split one step further, and the reason it belongs here rather
  than in an app is the reason `summary` does: neither app decodes the DSL,
  because a second copy of it would go stale there in the dark, and a sentence
  was then the only thing either could show. The hub already interprets the
  document to run it; this interprets it once more to draw it. Six rules, all of
  them the ones `summary` already lives by. `title` is the only field that is
  always there and `glyph` is an **opaque token** — the room-icon vocabulary
  applied to a step — so a step kind added later reaches an older app as an
  unrecognised mark over a line that is still true, and adding one needs no app
  release. A step is **three fields** because it is three thoughts (the act,
  what it acts on, the qualifier), and only the hub knows which half is which.
  **Two tenses**: a trigger is the moment of crossing ("goes above"), a
  condition is asked while the rule runs ("is above") — one table for both said
  a rule waits for its condition to move. `tone: "quiet"` marks a step that is
  not an act on the home (a wait, a log line), which is what lets an app draw a
  wait as the *gap* between steps. Nesting is `children` + `join`, indented
  rather than recursed. And it is **derived per read and read-only**: nothing
  addresses a node in the document, because a builder would be this same list
  with its steps addressable and that is a decision to make on purpose.
  `phrasing.ts` is the one place a stored number becomes what a person means by
  it, shared by both surfaces — two copies of that table is two places for the
  centi-°C mistake to come back in only one of them.
  **The catalog is generated** from the live zod schema and is the one source
  the agent, the apps and the docs all read — the `GET /permissions` rule
  applied to a vocabulary that will keep growing. Units are written out in
  words at every path and command, because a model that writes 22 for 22 °C
  produces a rule wrong by two orders of magnitude that reads perfectly.
