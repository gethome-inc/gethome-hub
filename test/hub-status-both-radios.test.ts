import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHubStatusReader } from '../src/core/hub-status.js';
import { writeRadioStandDown, recordRadioChoice } from '../src/core/radio.js';
import type { ApiDeps } from '../src/api/server.js';

/**
 * What a hub running **both** radios says about itself.
 *
 * Every radio surface in the apps was rewritten around a board that can only
 * afford one — the resting-radio rule, the "standing by" wording, the switch,
 * the notice under the dashboard — and all of it keys off facts this snapshot
 * reports. A Pi 4 or 5 never makes the choice, so none of that machinery
 * should ever fire there, and the way it would go wrong is the quiet way:
 * devices silently excluded from the "needs attention" count on a home where
 * nothing is resting at all.
 *
 * That cannot be tried on the 512 MB board this was developed against — the OS,
 * the hub with Matter, and Zigbee2MQTT do not fit in 415 MB together, which is
 * the whole reason the one-radio rule exists — so it is pinned here instead.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'gethome-both-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The narrow slice of `ApiDeps` the snapshot actually reads.
 *
 * A cast rather than a whole server: this is a pure function of a handful of
 * fields, and building a real `MatterAdapter` here would load `@matter/main` —
 * by far the largest thing in the graph — to read two booleans off it.
 */
function reader(options: {
  budget: 'both' | 'one';
  zigbeeConnected: boolean;
  matter: boolean;
  coordinatorPath?: string;
  pressure?: { since: number; detail: string; willStandDown: boolean };
  settlingUntil?: number;
}) {
  const deps = {
    dataDir: dir,
    z2mDataDir: path.join(dir, 'zigbee2mqtt'),
    zigbeeEnvFile: path.join(dir, 'zigbee.env'),
    radioBudget: options.budget,
    radioPressure: { pressure: () => options.pressure },
    permitJoin: { state: { active: false, remainingSeconds: 0 } },
    ...(options.zigbeeConnected !== undefined
      ? { zigbee: { connected: options.zigbeeConnected } }
      : {}),
    ...(options.matter
      ? {
          matter: {
            bleStatus: { enabled: true },
            hasWifiCredentials: true,
            isCommissioning: false,
            settlingUntil: options.settlingUntil,
          },
        }
      : {}),
  } as unknown as ApiDeps;
  return createHubStatusReader(deps);
}

describe('a hub that runs both radios', () => {
  it('reports both live, with nothing in flight and nothing to trade', () => {
    const snapshot = reader({ budget: 'both', zigbeeConnected: true, matter: true }).snapshot();
    expect(snapshot.radio).toMatchObject({
      budget: 'both',
      canRunBoth: true,
      matter: true,
      applying: false,
    });
    expect(snapshot.zigbee).toMatchObject({ enabled: true, connected: true });
  });

  it('says the coordinator is there without touching the disk to find out', () => {
    // Zigbee being connected is proof enough on its own, and this route is the
    // health check every app and installer polls — so the file is not read at
    // all on a healthy hub. Nothing is written here, and the answer is still
    // `present` rather than the `unknown` an unread file would give.
    const snapshot = reader({ budget: 'both', zigbeeConnected: true, matter: true }).snapshot();
    expect(snapshot.zigbee.coordinator).toBe('present');
  });

  it('still answers what its Matter pairing can do', () => {
    const snapshot = reader({ budget: 'both', zigbeeConnected: true, matter: true }).snapshot();
    expect(snapshot.matter).toEqual({ bluetooth: true, wifi: true, commissioning: false });
  });

  it('reports a radio that is off as off, without calling it a trade', () => {
    // The distinction the whole "standing by" vocabulary rests on. A board that
    // could run both and is running one is not a board that chose; the app must
    // go on treating those devices as genuinely offline, because on this
    // hardware nothing is going to hand the radio back.
    const stick = path.join(dir, 'usb-coordinator-if00');
    writeFileSync(stick, '');
    writeFileSync(path.join(dir, 'zigbee.env'), `ZIGBEE_ADAPTER=${stick}\n`);
    const snapshot = reader({ budget: 'both', zigbeeConnected: false, matter: true }).snapshot();
    expect(snapshot.radio.canRunBoth).toBe(true);
    // The coordinator is plugged in and Zigbee is down anyway — which on a
    // both-board is a fault to look at, not a choice somebody made.
    expect(snapshot.zigbee.coordinator).toBe('present');
    expect(snapshot.zigbee.connected).toBe(false);
  });

  it('stops claiming to be switching once the asked-for radio is live', () => {
    // A mode change that resolves to the radio already running — `auto` →
    // `matter` on a hub already on Matter — is one `gethome-zigbee-detect`
    // correctly answers by restarting nothing. The request is still on disk,
    // and reading it alone left every app drawing "switching radios" for two
    // and a half minutes over a hub that was never going anywhere.
    writeFileSync(path.join(dir, 'radio-mode'), 'matter\n');
    writeFileSync(path.join(dir, 'radio-requested'), `${Date.now()}\n`);
    const snapshot = reader({ budget: 'one', zigbeeConnected: false, matter: true }).snapshot();
    expect(snapshot.radio.mode).toBe('matter');
    expect(snapshot.radio.matter).toBe(true);
    expect(snapshot.radio.applying).toBe(false);
  });

  it('keeps claiming it while the asked-for radio has not arrived', () => {
    // The other half, and the reason the window still exists: asking for
    // Zigbee on a hub with no coordinator is a perfectly reasonable thing to
    // do, correctly changes nothing, and must end by *timing out* rather than
    // by a target that is never going to be live.
    writeFileSync(path.join(dir, 'radio-mode'), 'zigbee\n');
    writeFileSync(path.join(dir, 'radio-requested'), `${Date.now()}\n`);
    const snapshot = reader({ budget: 'one', zigbeeConnected: false, matter: true }).snapshot();
    expect(snapshot.radio.applying).toBe(true);
    expect(snapshot.radio.applyingSince).toBeGreaterThan(0);
  });

  it('tells a one-radio board apart, which is what every switch keys off', () => {
    const snapshot = reader({ budget: 'one', zigbeeConnected: true, matter: false }).snapshot();
    expect(snapshot.radio.canRunBoth).toBe(false);
    expect(snapshot.radio.matter).toBe(false);
    // No Matter running, so nothing to say about Matter pairing — presence is
    // the capability, and `bluetooth: false` here would send somebody with no
    // Matter at all off to look at their Bluetooth.
    expect(snapshot.matter).toBeUndefined();
  });
});

/**
 * A board measured for one radio, asked for two.
 *
 * The budget is measured against a **full** home and most homes are nowhere
 * near it, so `both` is allowed on a `one` board and the hub watches instead
 * of refusing. What the snapshot owes an app is the two things it cannot work
 * out for itself: whether this hub is new enough to be asked at all, and
 * whether it has ever had to take the offer back.
 */
describe('a board measured for one, asked for both', () => {
  it('says what it can be asked for, which is not what it recommends', () => {
    const snapshot = reader({ budget: 'one', zigbeeConnected: true, matter: true }).snapshot();
    // Both, together, on one hub: `budget` is the advice an app warns from and
    // `modes` is the vocabulary it offers. A hub that answered only the first
    // would leave an app guessing, and the guess it makes on a hub too old for
    // `both` is a button whose only outcome is a 400.
    expect(snapshot.radio.budget).toBe('one');
    expect(snapshot.radio.modes).toContain('both');
  });

  it('stops claiming to be switching only once *both* radios are there', () => {
    // The one mode that lands in two stages. `matter` and `zigbee` each name a
    // single target, so the existing rule reads one boolean; `both` is over
    // when the slower of the two arrives, and treating it like the others left
    // every app drawing "switching radios" over a hub that had finished.
    writeFileSync(path.join(dir, 'radio-mode'), 'both\n');
    writeFileSync(path.join(dir, 'radio-requested'), `${Date.now()}\n`);

    const half = reader({ budget: 'one', zigbeeConnected: false, matter: true }).snapshot();
    expect(half.radio.applying).toBe(true);

    const whole = reader({ budget: 'one', zigbeeConnected: true, matter: true }).snapshot();
    expect(whole.radio.applying).toBe(false);
  });

  it('says nothing about standing down on a hub it has never happened to', () => {
    // Absence is the answer, the way it is for `matter`, `history` and
    // `portraits`. A zeroed record would have every app drawing a reassurance
    // nobody asked for.
    expect(reader({ budget: 'one', zigbeeConnected: true, matter: true }).snapshot().radio.standDown)
      .toBeUndefined();
  });

  it('says a radio is owed, and whether the hub will get it back itself', () => {
    // **Suspended, not revoked.** The stand-down writes `auto` into the mode,
    // because that is the only way a hub can change its own radios — so an app
    // reading the mode alone would have to draw the switch as untouched, which
    // is the hub silently undoing a decision rather than parking it.
    writeRadioStandDown(dir, { reason: 'memory-pressure', wish: 'both', bootId: 'boot-a' });
    const owed = reader({ budget: 'one', zigbeeConnected: true, matter: false }).snapshot();
    expect(owed.radio.standDown).toMatchObject({ suspended: true, willRetry: true });

    // And nothing is owed to a hub that is already running both, whatever its
    // history — the question is about now.
    writeFileSync(path.join(dir, 'radio-mode'), 'both\n');
    const running = reader({ budget: 'one', zigbeeConnected: true, matter: true }).snapshot();
    expect(running.radio.standDown).toMatchObject({ suspended: false, willRetry: false });
  });

  it('stops promising a retry once the tries are spent', () => {
    // The sentence somebody needs at that point is *the hub has stopped
    // trying, and you can still turn it on* — and an app can only say it if
    // the hub distinguishes "will try" from "is stood down".
    const record = writeRadioStandDown(dir, { reason: 'memory-pressure', wish: 'both' });
    writeFileSync(
      path.join(dir, 'radio-stand-down'),
      `${JSON.stringify({ ...record, autoRetries: 2 })}\n`,
    );
    const snapshot = reader({ budget: 'one', zigbeeConnected: true, matter: false }).snapshot();
    expect(snapshot.radio.standDown).toMatchObject({ suspended: true, willRetry: false });
  });

  it('reports the stand-down, and whether it still needs saying', () => {
    writeRadioStandDown(dir, {
      reason: 'memory-pressure',
      detail: 'the hub was held at its memory limit in 7 of the last 10 checks',
    });
    const raised = reader({ budget: 'one', zigbeeConnected: true, matter: false }).snapshot();
    expect(raised.radio.standDown).toMatchObject({
      reason: 'memory-pressure',
      count: 1,
      acknowledged: false,
    });

    // Answering the notice does not erase the history. The two have different
    // lifetimes on purpose: the notice is over the moment somebody chooses a
    // radio, and the count is what an app says when it offers `both` again.
    recordRadioChoice(dir, 'matter');
    const answered = reader({ budget: 'one', zigbeeConnected: true, matter: false }).snapshot();
    expect(answered.radio.standDown).toMatchObject({ count: 1, acknowledged: true });
  });
});

/**
 * Memory trouble, which is not only a small board's problem.
 *
 * A Pi 5 whose memory is being eaten has the same symptom and a completely
 * different answer: there is no second radio to hand back, because the board
 * is supposed to run both. Saying nothing there — because the hub has no move
 * to make — is how a home degrades quietly, so the reading is reported on
 * every board and `willStandDown` is what separates *something is about to
 * happen* from *somebody should look at this*.
 */
describe('what the hub says about its memory', () => {
  const pressure = {
    since: Date.now(),
    detail: 'the hub was held at its memory limit in 4 of the last 10 checks',
    willStandDown: false,
  };

  it('says nothing on a board that is fine', () => {
    expect(reader({ budget: 'both', zigbeeConnected: true, matter: true }).snapshot().radio.pressure)
      .toBeUndefined();
  });

  it('reports it on a board measured for both, with nothing about to happen', () => {
    const snapshot = reader({
      budget: 'both',
      zigbeeConnected: true,
      matter: true,
      pressure,
    }).snapshot();
    expect(snapshot.radio.pressure).toEqual(pressure);
  });

  it('reports it on a small board with the warning that it will act', () => {
    const snapshot = reader({
      budget: 'one',
      zigbeeConnected: true,
      matter: true,
      pressure: { ...pressure, willStandDown: true },
    }).snapshot();
    expect(snapshot.radio.pressure?.willStandDown).toBe(true);
  });
});

/**
 * A switch that turns a radio **off**.
 *
 * `applying` used to ask only whether the radio somebody asked for was up,
 * which is right for every switch that turns one on and wrong for every switch
 * that turns one off. Leaving `both` for `zigbee` left Zigbee already
 * connected, so the hub reported the switch as landed the instant it was
 * recorded — no progress bar, no planned downtime — and then went off the
 * network for seventy seconds with nothing on any screen to say why.
 *
 * Found on a real hub, on video. `both` → `matter` had exactly the same defect
 * and nobody had noticed, which is the reason both directions are pinned here.
 */
describe('leaving both radios for one', () => {
  beforeEach(() => {
    writeFileSync(path.join(dir, 'radio-requested'), `${Date.now()}\n`);
  });

  it('is still applying while Matter has not gone yet', () => {
    writeFileSync(path.join(dir, 'radio-mode'), 'zigbee\n');
    const midFlight = reader({ budget: 'one', zigbeeConnected: true, matter: true }).snapshot();
    expect(midFlight.radio.applying).toBe(true);
  });

  it('is done once Matter has actually gone', () => {
    writeFileSync(path.join(dir, 'radio-mode'), 'zigbee\n');
    const landed = reader({ budget: 'one', zigbeeConnected: true, matter: false }).snapshot();
    expect(landed.radio.applying).toBe(false);
  });

  it('is still applying while Zigbee has not gone yet', () => {
    writeFileSync(path.join(dir, 'radio-mode'), 'matter\n');
    const midFlight = reader({ budget: 'one', zigbeeConnected: true, matter: true }).snapshot();
    expect(midFlight.radio.applying).toBe(true);
  });

  it('is done once Zigbee has actually gone', () => {
    writeFileSync(path.join(dir, 'radio-mode'), 'matter\n');
    const landed = reader({ budget: 'one', zigbeeConnected: false, matter: true }).snapshot();
    expect(landed.radio.applying).toBe(false);
  });

  it('still bounds a request that can never be satisfied', () => {
    // The half the window exists for, and the half this must not break:
    // asking for Zigbee on a hub with no coordinator is reasonable, correctly
    // changes nothing, and has to end by *timing out* rather than by a target
    // that is never going to arrive.
    writeFileSync(path.join(dir, 'radio-mode'), 'zigbee\n');
    const stuck = reader({ budget: 'one', zigbeeConnected: false, matter: true }).snapshot();
    expect(stuck.radio.applying).toBe(true);
    expect(stuck.radio.applyingSince).toBeGreaterThan(0);
  });
});

/**
 * Matter still looking for the devices it already owns.
 *
 * Zigbee2MQTT hands its whole device list over in one retained message, so a
 * Zigbee home is complete a second after the radio is. A Matter controller
 * opens a CASE session per node — twenty to thirty seconds on a Zero 2 W — and
 * those devices were read back from the database with the `online: false` they
 * were given when Matter was last switched *off*. So a working home read
 * "1 offline · needs attention" for half a minute after every switch to
 * Matter, about an accessory that was about to answer.
 */
describe('the window where Matter has not found its devices yet', () => {
  it('says nothing once the controller has reached everything it owns', () => {
    const snapshot = reader({ budget: 'one', zigbeeConnected: false, matter: true }).snapshot();
    expect(snapshot.matter).toBeDefined();
    expect(snapshot.matter?.settlingUntil).toBeUndefined();
  });

  it('carries the moment it stops making excuses for a silent device', () => {
    // A bound, not a promise. The window is only ever *reached* by a node that
    // is genuinely not there — which is the one real offline device, and it
    // must not stay hidden behind "still looking" for ever.
    const until = Date.now() + 45_000;
    const snapshot = reader({
      budget: 'one',
      zigbeeConnected: false,
      matter: true,
      settlingUntil: until,
    }).snapshot();
    expect(snapshot.matter?.settlingUntil).toBe(until);
  });

  it('says nothing at all on a hub with no Matter running', () => {
    // Presence is the capability, as everywhere else here: a hub without
    // Matter has nothing to say about how long its Matter takes to wake up.
    const snapshot = reader({ budget: 'one', zigbeeConnected: true, matter: false }).snapshot();
    expect(snapshot.matter).toBeUndefined();
  });
});
