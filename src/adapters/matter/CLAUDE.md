# `src/adapters/matter/` — the Matter controller

Loaded when Claude works with files under `src/adapters/matter/`. The root
`CLAUDE.md` carries the rules from here that bind code outside this directory,
and the pin on matter.js stays there with it. `docs/matter.md` is canonical —
update it in the same change.

- **An accessory that has never been on a network cannot be found on one, and
  where to look is the accessory's answer rather than a setting.** A
  factory-new — or factory-reset — Wi-Fi Matter accessory advertises over
  Bluetooth LE and nowhere else. `MatterAdapter` used to hardcode
  `discoveryCapabilities: { onIpNetwork: true }` for every setup code, so it
  searched the LAN for a device that was never going to be there; matter.js
  applies **no discovery timeout at all** when one is not passed (`Discovery`
  guards its `withTimeout` on `!== undefined`), so the job never settled and
  the app read "Pairing with your hub" until somebody force-quit it — thirty-five
  minutes, on the hub this was found on. `adapters/matter/setup-code.ts` reads
  the QR's own `discoveryCapabilities` instead, and a **manual code carries
  none**: `undefined` there means "the code did not say" and is answered by
  looking everywhere, never by guessing one place. BLE arrives through an
  **optional** dependency installed into the environment *before* the
  controller is built (afterwards it is a transport nothing is holding), with
  every failure resolving to a named reason rather than throwing — see
  `deploy/CLAUDE.md` for the rfkill and capability halves, and `docs/matter.md`,
  which is canonical.
  **Three refusals happen before anything is searched for**, because in each the
  answer cannot change while somebody waits: a code the hub cannot read, an
  accessory whose code says Bluetooth on a hub without it, and one with no
  network that the hub has no Wi-Fi network to give — no password on file, or a
  network only 5 GHz can see, which `deploy/wifi-credentials.sh` declines to hand
  over (see `docs/matter.md`). Everything else is bounded
  (three minutes' discovery, four and a half for the job), cancellable — which
  stops the *discovery*, not just the screen, and is why the hub pairs **one
  accessory at a time** — and classified into words somebody can act on
  (`commission-failures.ts`, `write-failures.ts`'s shape and both its rules:
  open `kind`, most-specific-first). **A failed pairing is logged**, which it
  was not: the only record of one was a WebSocket frame that had already gone,
  so the journal of a hub whose owner could pair nothing showed a line saying
  discovery had started and nothing else, ever. And **the step is a real signal,
  never a timer**: a candidate reaching the controller's peer set is the moment
  the advice changes from "hold its button" to "leave it alone", and a
  five-second timeout would say the same thing about a hub that had found
  nothing.
  **Two things it deliberately cannot do yet are written down** under
  *Not built yet* in `docs/matter.md`: giving an accessory away to another
  ecosystem (the hub takes devices in and cannot share them, which is the fear
  somebody has *before* they pair anything), and pairing from the phone when
  the hub is out of Bluetooth range. Both carry the detail and the open
  questions; neither is started.
  **A device is not offline because the hub has only just started looking for
  it.** Zigbee2MQTT hands its whole list over in one retained message; a Matter
  controller opens a CASE session per node, which is twenty to thirty seconds
  on a Zero 2 W — and those devices are read back from the database with the
  `online: false` they were given when Matter was last switched *off*. So every
  switch to Matter reported "1 offline · needs attention" for half a minute
  about an accessory that was about to answer. `matter.settlingUntil` is the
  hub saying it has not finished looking, and an app draws those devices as
  *connecting*. It **clears when the last node connects, not when the clock
  runs out** — the controller knows what it owns and what it has reached, so
  there is nothing to guess — and the clock is a bound rather than a promise,
  because the node that never answers is the one genuinely offline device and
  must not hide behind "still looking" for ever.
  **It covers the controller coming up as well**, which is the same bug one
  step earlier and the half this first shipped without. The adapters start
  after the API is listening, so every `GET /hub` in the seconds matter.js
  spends loading and opening its storage was answered by an adapter that had
  not begun looking — reporting a settled home, while `radio.matter` already
  said `true` because the adapter had been *constructed*. That is the window
  every switch to Matter lands in, so the fix for the paragraph above did not
  reach the case it was written for. The two phases are bounded separately: a
  clock running while matter.js loads counts time in which no node could have
  reported in, so charging it to the nodes shortens the window they actually
  get on precisely the boards slow enough to need all of it. The arithmetic is
  `adapters/matter/settling.ts` rather than a getter in the adapter, for the
  reason `reducer.ts` and `setup-code.ts` are their own files: reading it
  through `adapter.ts` loads `@matter/main`, so a rule both apps draw every
  Matter device from would be a rule no test could reach.
  **And nothing `GET /hub` reads may throw**, which that first version learned
  the hard way. It asked the controller what it was commissioned to *before*
  deciding the phase, and matter.js refuses that question until `start()` has
  finished (`getCommissionedNodes` asserts an instance) — while the controller
  *object* exists for the tens of seconds `start()` spends loading and opening
  its storage on a Zero 2 W. So every `GET /hub` in that window threw straight
  out of the route, and that route is the health check `install.sh` gates on:
  `curl -fsS` exited 22 and a real install aborted against a hub that was
  coming up perfectly well and answered fine a minute later. The commissioned
  list is a **function** on `SettlingPhase` now, called only in the one phase
  that can answer it — which also means the health check asks matter.js nothing
  at all in the steady state — with a `catch` behind it as the second layer,
  because the cost of being wrong here is a failed install rather than a wrong
  number. Every other read behind that route already obeys this (each file read
  is `try`/`catch` with a documented fallback); a new one has to.
  **And the hub can be asked what it can hear** (`GET /matter/discoverable`),
  because Bluetooth range is the one part of pairing nobody can see and
  `not-found` is the same word for "two rooms away" and "never went into
  pairing mode". It is refused while a pairing runs, and that is a measurement:
  a second scanner beside the hub's own took fifteen seconds of neighbourhood
  advertisements from 231 down to 2 on a Zero 2 W, and a starved scan reports
  an *empty list* — the wrong answer in the one direction somebody acts on.
- The Matter reducer (`src/adapters/matter/reducer.ts`) is a 1:1 port of the
  iOS `MatterStateReducer` — keep them in lockstep if either changes.
