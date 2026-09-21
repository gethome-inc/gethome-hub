# `test/` — traps in the suites themselves

Loaded when Claude works with files under `test/`. The root `CLAUDE.md` keeps
the testing rules that bind `src/` and `deploy/` as well: the shell-portability
trap, the four suites any access change owes, and what `npm run typecheck`
covers.

- **A mock's history is per test, and a `beforeAll` that exercises one is the
  trap.** Vitest clears every mock before each test (`clearMocks`, its default
  since 5.0), so `mock.calls` in a test body is that test's calls and nothing
  else — write counts relative to the test, never as the suite's running total.
  The half that is not merely a rewrite is the one place a suite asserts on what
  a *hook* did: the clear runs before the first test, so
  `expect(m).not.toHaveBeenCalled()` about a `beforeAll` is an assertion that
  cannot fail — the same shape as the shell trap in the root `CLAUDE.md`, where
  the test looked green because it had stopped reaching anything. Take the count
  in the hook and assert on that (`test/integration/zigbee-adapter.test.ts` is
  the worked example, and it is the only suite here with a mock outside an
  `it`). The running-total form hides the other direction too: a wait for "at
  least two calls" that the previous test had already satisfied returned at
  once, so the race it existed to close was never actually held open.
- **And a wait gates nothing when something else can satisfy it.** The same
  shape again, one suite over, and this one only ever bit in CI:
  `test/integration/mqtt-roundtrip.test.ts` waited for
  `registry.listDevices().length >= 10` and then asserted that the MQTT
  convention device was among them. Two adapters fill that list and
  `registry.start()` starts them in turn, so the Zigbee fixtures — sixteen of
  them, six past the ten asked for — met the gate on their own while the
  convention device behind the second adapter was still arriving. It passed for
  months because adopting sixteen devices takes long enough that the other
  adapter usually got there, and then failed on a loaded runner reading exactly
  the sixteen Zigbee devices and no `Pool pump`. **Wait for the thing the
  assertion is about**, not for a number that anything in the process can reach:
  every other test in that file already did, waiting on a device *by name* or on
  the state it was about to check. Where the count is the point, derive it from
  the fixture rather than writing it out, or adding a fixture quietly shrinks
  the wait; and give `waitFor` a label, since "timed out waiting for condition"
  names neither the suite's problem nor yours.
