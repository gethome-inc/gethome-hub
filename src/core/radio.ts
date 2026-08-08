import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Which radio this hub runs, on a board that can only afford one.
 *
 * A 512 MB board fits the OS, the hub, and *one* of Zigbee2MQTT (~150 MB, its
 * own process) or Matter (~60-90 MB inside the hub) — not both. `install.sh`
 * measures that and writes the budget into `GETHOME_RADIO`; this file is the
 * other half, the owner's choice between them.
 *
 * **The hub only writes the choice; it never applies it.** Applying it means
 * editing `/etc/gethome/hub.env`, starting or stopping a systemd unit and
 * restarting the hub itself — all root, none of it something a hub process
 * should be able to do. Instead the hub writes one word into its own data
 * directory, a `gethome-radio.path` unit notices, and `gethome-zigbee-detect`
 * applies it. That script already owns this decision: it runs at boot, on
 * every USB plug and unplug, and at the end of the install, and it is the only
 * thing that knows whether a coordinator is actually there.
 *
 * So a mode set here is a *request*. What the hub reports as live comes from
 * `ADAPTER_MATTER` and whether the Zigbee adapter connected — never from this
 * file.
 */
export type RadioMode = 'auto' | 'zigbee' | 'matter';

/** How many radios the board affords at once. Measured, not chosen. */
export type RadioBudget = 'both' | 'one';

export const RADIO_MODES: readonly RadioMode[] = ['auto', 'zigbee', 'matter'] as const;

const FILE = 'radio-mode';

function modeFile(dataDir: string): string {
  return path.join(dataDir, FILE);
}

/**
 * The owner's current choice, or `auto` when they have never made one.
 *
 * `auto` is not a fallback for a damaged file so much as the honest default:
 * follow the hardware. A coordinator is something somebody went out and
 * bought, so it takes the board when it is plugged in; with nothing plugged
 * in, Matter takes it. Anything unreadable or unrecognised reads as `auto`
 * for the same reason — guessing at a corrupted preference is worse than
 * behaving the way an unconfigured hub does.
 */
export function readRadioMode(dataDir: string): RadioMode {
  let raw: string;
  try {
    raw = readFileSync(modeFile(dataDir), 'utf8');
  } catch {
    return 'auto';
  }
  const value = raw.trim();
  return (RADIO_MODES as readonly string[]).includes(value) ? (value as RadioMode) : 'auto';
}

/**
 * Record the owner's choice. Returns once the file is written — the switch
 * itself happens a moment later, out of process, and the hub may be restarted
 * by it, so callers must reply before relying on anything downstream.
 */
export function writeRadioMode(dataDir: string, mode: RadioMode): void {
  mkdirSync(dataDir, { recursive: true });
  // Written in place rather than through a temp file and a rename: the file is
  // one word, so the write is a single syscall, and a plain write is what
  // `PathModified` is guaranteed to notice. The reader validates anyway and
  // falls back to `auto`, so a torn read costs a retry, not a wrong radio.
  writeFileSync(modeFile(dataDir), `${mode}\n`, { mode: 0o644 });
}
