import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Why the Zigbee radio isn't running, in the hub's own words.
 *
 * `zigbee.connected: false` is a fact with several very different causes, and
 * until now the hub reported the fact and left the cause in a log on the Pi.
 * That is the wrong place for it: the person who needs it is usually looking at
 * an app on another machine, and "check journalctl" is homework they cannot do.
 *
 * The hub can answer this itself. Zigbee2MQTT writes its own log into
 * `<Z2M data>/log/<timestamp>/log.log`, and that directory belongs to the same
 * service account the hub runs as — no root, no journal, no SSH. So the hub
 * reads it, recognises the failures worth naming, and puts the answer in
 * `GET /hub` where every app can use it.
 *
 * `kind` is for apps that want to write their own explanation (and to add a
 * button for the ones that have a fix). `summary` is so an app that has never
 * heard of a given kind still shows something true.
 */
export type ZigbeeProblemKind =
  | 'firmware-too-old'
  | 'adapter-unidentified'
  | 'port-missing'
  | 'onboarding-pending'
  | 'radio-unreachable';

export interface ZigbeeProblem {
  kind: ZigbeeProblemKind;
  /** One sentence, safe to show as-is. */
  summary: string;
  /** The line from Zigbee2MQTT's log that decided it. */
  detail: string;
}

/**
 * Match Zigbee2MQTT's log against the failures worth naming.
 *
 * Ordered most specific first: several of these co-occur — a stick whose
 * firmware is too old also logs the generic "Failed to start zigbee-herdsman"
 * right after — and the specific one is the only one that helps.
 *
 * Anything unrecognised deliberately returns nothing rather than guessing.
 * A wrong diagnosis is worse than "it isn't connected", which the caller
 * already knows.
 */
export function classifyZigbeeLog(log: string): ZigbeeProblem | undefined {
  // Zigbee2MQTT indents its own log lines — `error: \tz2m: Error: …` — and this
  // string is rendered as one line in an app, where an embedded tab is just a
  // hole in the sentence. Collapse runs of whitespace rather than reproducing
  // the file's layout in a place that has none.
  const tidy = (text: string): string => text.replace(/\s+/g, ' ').trim();
  const line = (pattern: RegExp): string | undefined => {
    const found = log.split('\n').reverse().find((l) => pattern.test(l));
    return found === undefined ? undefined : tidy(found);
  };

  // A SONOFF ZBDongle-E ships running EmberZNet 6.10, which speaks EZSP v8,
  // while Zigbee2MQTT's ember driver needs 13 or newer. The radio answers and
  // then refuses — so this is the one failure where everything looks right.
  // Deliberately no version numbers in the summary, though the log has two.
  // These are *protocol* versions (EZSP 8 vs 13+), and every browser flasher
  // shows *firmware* versions instead — SONOFF's offers "6.10.3 → 8.0.2" for
  // exactly this stick. Put "needs 13 or newer" in front of somebody looking at
  // an 8.0.2 and the number they can act on looks like the wrong one. The raw
  // line keeps both for anyone who wants them.
  const ezsp = /EZSP protocol version \(\d+\) is not supported by Host \[[\d-]+\]/.exec(log);
  if (ezsp) {
    return {
      kind: 'firmware-too-old',
      summary:
        'The Zigbee coordinator is working, but its firmware is too old for Zigbee2MQTT. ' +
        'Updating it is a one-time job — about a minute, in a browser — and nothing else on ' +
        'the hub is affected.',
      detail: line(/EZSP protocol version/) ?? tidy(ezsp[0]),
    };
  }

  if (/No valid USB adapter found/.test(log)) {
    return {
      kind: 'adapter-unidentified',
      summary:
        'Zigbee2MQTT could not work out what kind of coordinator is plugged in, so it will not ' +
        'talk to it. This usually means a stick built on a plain USB-serial chip, which has no ' +
        'name of its own to go by.',
      detail: line(/No valid USB adapter found/) ?? 'No valid USB adapter found',
    };
  }

  if (/spawn udevadm ENOENT/.test(log)) {
    return {
      kind: 'port-missing',
      summary:
        'Zigbee2MQTT could not inspect the USB port. The system tool it uses for that (udevadm) ' +
        'is missing or unreachable from the service.',
      detail: line(/udevadm/) ?? 'spawn udevadm ENOENT',
    };
  }

  // Should not happen — install.sh turns onboarding off — but if it ever comes
  // back, saying so beats a hub that is silently waiting for a browser.
  if (/Onboarding page is available/.test(log)) {
    return {
      kind: 'onboarding-pending',
      summary:
        'Zigbee2MQTT is waiting for someone to finish its own setup page, so it has not started ' +
        'the radio. The hub is meant to configure it directly; re-running the installer fixes this.',
      detail: line(/Onboarding page is available/) ?? 'Onboarding page is available',
    };
  }

  // Generic last: it means the radio was reached for and did not answer, which
  // is worth reporting even without a specific cause.
  if (/Failed to start zigbee-herdsman|Error while starting zigbee-herdsman/.test(log)) {
    return {
      kind: 'radio-unreachable',
      summary:
        'Zigbee2MQTT could not start the radio. The hub itself is fine; Zigbee devices will not ' +
        'pair until this is sorted out.',
      detail: line(/Error:/) ?? 'Failed to start zigbee-herdsman',
    };
  }

  return undefined;
}

/** How much of the log to read. Enough for one failed start, and bounded. */
const TAIL_BYTES = 64 * 1024;

/**
 * Read Zigbee2MQTT's newest log and classify it.
 *
 * Zigbee2MQTT starts a new `log/<timestamp>/` directory per run, and the names
 * sort chronologically, so the last one is the run that matters. Every failure
 * here is expected — no Zigbee2MQTT installed, never started, a directory the
 * hub can't read — and all of them mean the same thing to a caller: nothing to
 * say. They must never turn into an error on `GET /hub`.
 */
export function readZigbeeProblem(z2mDataDir: string): ZigbeeProblem | undefined {
  try {
    const logs = path.join(z2mDataDir, 'log');
    const runs = readdirSync(logs)
      .filter((name) => {
        try {
          return statSync(path.join(logs, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
    const newest = runs[runs.length - 1];
    if (newest === undefined) return undefined;

    const file = path.join(logs, newest, 'log.log');
    const size = statSync(file).size;
    // Seek to the tail rather than reading the file and slicing it: these logs
    // grow without bound on a busy network, and this sits behind a public
    // endpoint. A partial multi-byte character at the seam is harmless — every
    // pattern here is ASCII and the first line is discarded by `split('\n')`
    // finding a later match, or matched anyway.
    const from = Math.max(0, size - TAIL_BYTES);
    const length = size - from;
    if (length <= 0) return undefined;
    const buffer = Buffer.allocUnsafe(length);
    const fd = openSync(file, 'r');
    let read: number;
    try {
      read = readSync(fd, buffer, 0, length, from);
    } finally {
      closeSync(fd);
    }
    return classifyZigbeeLog(buffer.subarray(0, read).toString('utf8'));
  } catch {
    return undefined;
  }
}
