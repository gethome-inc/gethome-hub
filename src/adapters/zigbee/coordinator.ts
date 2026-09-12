import { existsSync, readFileSync } from 'node:fs';

/**
 * Whether a Zigbee coordinator is plugged into this machine.
 *
 * `zigbee.connected: false` has always been two completely different homes
 * wearing one word, and the apps picked the wrong one. A hub with no stick and
 * a hub whose stick is sitting in its socket while **Matter has the board**
 * both report exactly that, so switching a one-radio Pi to Matter made the app
 * say *"Zigbee · no stick"* — about a coordinator the owner could see from
 * where they were standing, that the hub had detected, and that the hub had
 * deliberately stood down. The one thing a person needs to know there is that
 * nothing is broken and the switch is reversible; instead they were told their
 * hardware had gone missing.
 *
 * The hub cannot see USB itself — `gethome-zigbee-detect` is the only thing
 * that knows, it runs at boot and on every plug and unplug, and it writes what
 * it found into `/etc/gethome/zigbee.env`, world-readable. So: read the path it
 * recorded and ask whether it is still there. Two file operations, behind a
 * cache, on a route that is polled.
 *
 * Deliberately **not** a scan of `/dev/serial/by-id`. That is the detector's
 * job and it does it with a device table, a USB-id table and a `maybe` tier;
 * a second, dumber copy of that in the hub would eventually disagree with the
 * first, and the two disagreeing is worse than either being wrong.
 */
export type CoordinatorPresence =
  /** Recorded, and the device node is there right now. */
  | 'present'
  /** Recorded, and not there — the stick is out, or being reflashed. */
  | 'absent'
  /** Nothing was ever recorded: this hub has never seen a coordinator. */
  | 'unknown';

/**
 * Read the detector's record.
 *
 * Every failure is expected — no file (a hub with no installer, a Mac running
 * the suite), no permission, a half-written line — and all of them mean
 * `unknown`, which is what a hub that has never had Zigbee should say.
 */
export function readCoordinatorPresence(zigbeeEnvFile: string): CoordinatorPresence {
  let raw: string;
  try {
    raw = readFileSync(zigbeeEnvFile, 'utf8');
  } catch {
    return 'unknown';
  }
  // The by-id name rather than the node: `ZIGBEE_ADAPTER` names *which device
  // this is* and survives a reboot, while the `/dev/ttyACM0` beside it moves
  // the moment something else is plugged in. Checking the node would report a
  // coordinator present because a 3D printer took its number.
  const match = /^ZIGBEE_ADAPTER=(.*)$/m.exec(raw);
  const recorded = match?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2') ?? '';
  if (recorded.length === 0) return 'unknown';
  return existsSync(recorded) ? 'present' : 'absent';
}
