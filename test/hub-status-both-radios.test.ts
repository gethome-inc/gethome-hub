import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHubStatusReader } from '../src/core/hub-status.js';
import { writeRadioStandDown, acknowledgeRadioStandDown } from '../src/core/radio.js';
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
}) {
  const deps = {
    dataDir: dir,
    z2mDataDir: path.join(dir, 'zigbee2mqtt'),
    zigbeeEnvFile: path.join(dir, 'zigbee.env'),
    radioBudget: options.budget,
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
    acknowledgeRadioStandDown(dir);
    const answered = reader({ budget: 'one', zigbeeConnected: true, matter: false }).snapshot();
    expect(answered.radio.standDown).toMatchObject({ count: 1, acknowledged: true });
  });
});
