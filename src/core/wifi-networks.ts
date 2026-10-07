import { randomUUID, pbkdf2Sync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The Wi-Fi networks this hub knows, so it can be told about another one before
 * it is carried there.
 *
 * A hub is set up on one network and then moved — to a new flat, to a house in
 * the country — where it finds a network it has never heard of and answers
 * nothing. NetworkManager already joins any network it holds a profile for,
 * preferring the one it used most recently, so the whole fix is to hand it the
 * other profile *before* the move: the hub stays where it is today and joins
 * the new network the first time it powers up in range of it.
 *
 * **The hub records the request; it never applies it.** The profiles are root's,
 * and the point of the account this process runs as is that it cannot touch
 * them. So the shape `core/radio.ts` and `core/update.ts` already have: one file
 * into the hub's own data directory, `gethome-wifi.path` notices, and
 * `deploy/wifi-networks.sh` applies it as root and writes back two files this
 * module reads — the list of networks, and what became of the last change.
 *
 * **The password never reaches the disk as typed.** It is turned into the
 * network's 64-hex WPA key here, before the request is written — the derivation
 * GetHome Studio and Raspberry Pi Imager use for a card, and for the same
 * reason: the key joins this one network, while the passphrase is very often
 * the one somebody uses everywhere. The cost is a WPA3-only network, whose SAE
 * handshake needs the passphrase; a WPA2 or mixed-mode network, which is every
 * home router's default, joins with the key.
 */

const WIFI_DIR = 'wifi';

/** Why this machine cannot have its networks changed from an app. */
export type WifiUnavailableReason =
  /** Nothing on the machine was installed by an installer that knows how. */
  | 'not-installed'
  /** The system manages its Wi-Fi without NetworkManager. */
  | 'no-networkmanager';

export type WifiAvailability =
  | { available: true }
  | { available: false; reason: WifiUnavailableReason };

/** One network NetworkManager holds a profile for. */
export interface SavedWifiNetwork {
  /** NetworkManager's UUID for the profile — what `DELETE` names. */
  id: string;
  ssid: string;
  /** The hub is connected through this one right now. */
  connected: boolean;
}

/** The root script's own vocabulary for what went wrong. */
export type WifiChangeError =
  | 'invalid'
  | 'exists'
  | 'limit'
  | 'not_found'
  | 'connected'
  | 'nmcli'
  | 'unsupported';

export interface WifiChangeResult {
  id: string;
  action: 'add' | 'remove';
  state: 'applied' | 'failed';
  error?: WifiChangeError;
  /** NetworkManager's own words when it refused, or the script's sentence. */
  detail?: string;
  ssid?: string;
  /** The profile added or removed. */
  networkId?: string;
  at?: string;
}

/**
 * How many networks a hub may know. The root script enforces the same number
 * against NetworkManager itself; this is the hub saying so before it asks.
 */
export const MAX_WIFI_NETWORKS = 16;

/**
 * How long a written request may sit unconsumed before it counts as abandoned.
 * The path unit picks one up within a second; a request still there after a
 * minute is one nothing is going to read, and refusing every change behind it
 * for ever would turn one dead unit into a setting that can never be used.
 */
const PENDING_STALE_MS = 60 * 1000;

function wifiDir(dataDir: string): string {
  return path.join(dataDir, WIFI_DIR);
}

/**
 * Whether this machine can have its networks changed at all.
 *
 * `install.sh` writes `enabled` in the same breath as the units, or
 * `unsupported` with a reason when the system has no NetworkManager — never
 * both. Neither is the hub having been installed by something older than this,
 * and an app says "update the hub" for that rather than "this hub can't".
 * Never throws: `GET /hub` reads it, and nothing that route reads may.
 */
export function wifiAvailability(dataDir: string): WifiAvailability {
  try {
    if (existsSync(path.join(wifiDir(dataDir), 'enabled'))) return { available: true };
    const reason = readFileSync(path.join(wifiDir(dataDir), 'unsupported'), 'utf8').trim();
    if (reason === 'no-networkmanager') return { available: false, reason };
  } catch {
    // No reason file is the ordinary answer for a hub installed before this.
  }
  return { available: false, reason: 'not-installed' };
}

/** An SSID travels from the root script as hex, so any byte survives the trip. */
function fromHex(hex: string): string | undefined {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return undefined;
  return Buffer.from(hex, 'hex').toString('utf8');
}

function keyValues(raw: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of raw.split('\n')) {
    if (line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    // `network=` repeats; everything else is read once, first one wins.
    if (key !== 'network' && values.has(key)) continue;
    values.set(key, line.slice(eq + 1));
  }
  return values;
}

const PROFILE_ID = /^[0-9a-f-]{36}$/i;

/**
 * The networks this machine knows, as the root script last wrote them down —
 * at install, after every change, and on every association.
 *
 * Undefined when there is no list at all. Connected first, then by name, which
 * is the order a person reads them in: "this is where it is now, and these are
 * the others it would join".
 */
export function readSavedNetworks(
  dataDir: string,
): { networks: SavedWifiNetwork[]; updatedAt?: string } | undefined {
  let raw: string;
  try {
    raw = readFileSync(path.join(wifiDir(dataDir), 'networks'), 'utf8');
  } catch {
    return undefined;
  }
  const networks: SavedWifiNetwork[] = [];
  let updatedAt: string | undefined;
  for (const line of raw.split('\n')) {
    if (line.startsWith('updated=')) {
      updatedAt = line.slice('updated='.length).trim() || undefined;
      continue;
    }
    if (!line.startsWith('network=')) continue;
    const [id, connected, hex] = line.slice('network='.length).trim().split(' ');
    if (id === undefined || !PROFILE_ID.test(id) || hex === undefined) continue;
    const ssid = fromHex(hex);
    if (ssid === undefined) continue;
    networks.push({ id: id.toLowerCase(), ssid, connected: connected === '1' });
  }
  networks.sort((a, b) =>
    a.connected !== b.connected ? (a.connected ? -1 : 1) : a.ssid.localeCompare(b.ssid),
  );
  return { networks, ...(updatedAt !== undefined ? { updatedAt } : {}) };
}

const CHANGE_ERRORS = new Set<string>([
  'invalid',
  'exists',
  'limit',
  'not_found',
  'connected',
  'nmcli',
  'unsupported',
]);

/** What became of the last change the root script applied, or nothing. */
export function readWifiChangeResult(dataDir: string): WifiChangeResult | undefined {
  let raw: string;
  try {
    raw = readFileSync(path.join(wifiDir(dataDir), 'result'), 'utf8');
  } catch {
    return undefined;
  }
  const values = keyValues(raw);
  const id = values.get('id');
  const action = values.get('action');
  const state = values.get('state');
  if (id === undefined || id.length === 0) return undefined;
  if (action !== 'add' && action !== 'remove') return undefined;
  if (state !== 'applied' && state !== 'failed') return undefined;
  const error = values.get('error');
  const detail = values.get('detail');
  const ssid = values.get('ssid');
  const networkId = values.get('uuid');
  const at = values.get('at');
  const decoded = ssid !== undefined ? fromHex(ssid) : undefined;
  return {
    id,
    action,
    state,
    ...(error !== undefined && CHANGE_ERRORS.has(error) ? { error: error as WifiChangeError } : {}),
    ...(detail !== undefined && detail.length > 0 ? { detail } : {}),
    ...(decoded !== undefined ? { ssid: decoded } : {}),
    ...(networkId !== undefined && PROFILE_ID.test(networkId)
      ? { networkId: networkId.toLowerCase() }
      : {}),
    ...(at !== undefined && at.length > 0 ? { at } : {}),
  };
}

/** A change has been asked for and the root script has not picked it up yet. */
export function wifiChangePending(dataDir: string, now = Date.now()): boolean {
  try {
    const stat = statSync(path.join(wifiDir(dataDir), 'request'));
    return now - stat.mtimeMs < PENDING_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Whether a string is a network name Wi-Fi allows: 1–32 bytes, and nothing a
 * line-based file or a terminal could trip over. The root script checks the
 * same two things; this is where a person is told.
 */
export function ssidProblem(ssid: string): string | undefined {
  if (ssid.length === 0) return 'A Wi-Fi network needs a name.';
  if (Buffer.byteLength(ssid, 'utf8') > 32) return 'A Wi-Fi network name is at most 32 bytes long.';
  // C0, DEL and C1: the request file is one value per line, and the root
  // script refuses the same characters.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(ssid)) {
    return 'A Wi-Fi network name cannot contain line breaks or other control characters.';
  }
  return undefined;
}

const RAW_PSK = /^[0-9a-f]{64}$/i;

/**
 * The password as somebody typed it, checked; undefined when it is fine.
 *
 * Either a passphrase of 8–63 characters, or the network's 64-hex key itself —
 * which is what a card written by Raspberry Pi Imager or GetHome Studio carries,
 * so somebody copying one across can paste it. An open network is refused on
 * purpose: this API is plain HTTP with bearer tokens, and on a network with no
 * password every token a phone sends is readable by anybody in range.
 */
export function passwordProblem(password: string): string | undefined {
  if (RAW_PSK.test(password)) return undefined;
  if (password.length === 0) {
    return 'The hub only joins Wi-Fi networks that have a password.';
  }
  const bytes = Buffer.byteLength(password, 'utf8');
  if (bytes < 8 || bytes > 63) return 'A Wi-Fi password is 8 to 63 characters long.';
  if (/[\u0000-\u001f\u007f]/.test(password)) {
    return 'A Wi-Fi password cannot contain line breaks or other control characters.';
  }
  return undefined;
}

/**
 * The network's WPA key: PBKDF2-HMAC-SHA1 over the passphrase, salted with the
 * SSID, 4096 rounds, 32 bytes — the WPA2 derivation, and byte for byte what
 * Studio's `SDProvisioner.wpaPSK` computes. A 64-hex key is already the result
 * and passes through.
 */
export function wpaPsk(ssid: string, password: string): string {
  if (RAW_PSK.test(password)) return password.toLowerCase();
  return pbkdf2Sync(Buffer.from(password, 'utf8'), Buffer.from(ssid, 'utf8'), 4096, 32, 'sha1').toString(
    'hex',
  );
}

export type WifiChangeRequest =
  | { action: 'add'; ssid: string; psk: string; hidden: boolean }
  | { action: 'remove'; networkId: string };

/**
 * Ask for a change. Returns its id, which the root script copies into its
 * result so the route can tell its own answer from an older one.
 *
 * Written in place, as one write, for the reason `requestUpdate` gives:
 * `PathModified` is guaranteed to notice a single write-and-close, and the
 * script re-reads once if what it got was torn. Mode 0600 because, for an add,
 * it carries the network's key until the script consumes it a moment later.
 */
export function requestWifiChange(dataDir: string, change: WifiChangeRequest): string {
  const id = randomUUID();
  const lines = [`id=${id}`, `action=${change.action}`];
  if (change.action === 'add') {
    if (ssidProblem(change.ssid) !== undefined || !RAW_PSK.test(change.psk)) {
      throw new Error('refusing to write an invalid Wi-Fi request');
    }
    lines.push(`ssid=${change.ssid}`, `psk=${change.psk}`, `hidden=${change.hidden ? 1 : 0}`);
  } else {
    if (!PROFILE_ID.test(change.networkId)) throw new Error('refusing to write an invalid Wi-Fi request');
    lines.push(`uuid=${change.networkId}`);
  }
  mkdirSync(wifiDir(dataDir), { recursive: true });
  writeFileSync(path.join(wifiDir(dataDir), 'request'), `${lines.join('\n')}\n`, { mode: 0o600 });
  return id;
}

/**
 * Wait for the root script to say what became of a change.
 *
 * It is quick — a path unit, one `nmcli` call and a list — so a route can wait
 * and answer with the outcome rather than handing every app a receipt to poll.
 * Undefined when it took longer than the wait, which on a busy small board can
 * happen and is not a failure: the change is still queued.
 */
export async function awaitWifiChange(
  dataDir: string,
  id: string,
  timeoutMs: number,
  pollMs = 250,
): Promise<WifiChangeResult | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = readWifiChangeResult(dataDir);
    if (result?.id === id) return result;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
}
