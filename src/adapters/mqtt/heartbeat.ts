/**
 * Which MQTT devices have gone quiet.
 *
 * A device's last will is how the hub hears that it went away — but only a
 * broker that is running can send one. A hub that loses power takes its broker
 * with it, and the broker comes back from the copy it last saved (every half
 * hour), still holding the device's retained `online`. A device switched off
 * in the meantime has no connection left for the broker to time out, so nothing
 * ever says `offline`, and it reads online for as long as it stays off. That
 * was a board unplugged while its hub's Pi was without power.
 *
 * So a device may also say how often it will speak, on its heartbeat topic: a
 * number of seconds, retained, published that often. One that has said so and
 * then goes quiet for two and a half of those intervals is marked offline, as
 * its will would have marked it; anything it publishes live brings it back.
 * **A retained message is not the device speaking**: after a restart it can be
 * hours old, so the allowance of a device first heard that way starts when the
 * hub began listening. A device that never publishes a heartbeat is never
 * judged by one, and its will is all there is, as before.
 */

/** The shortest and longest interval a device may ask for, in seconds. */
export const MIN_HEARTBEAT_SECONDS = 10;
export const MAX_HEARTBEAT_SECONDS = 3600;
/** Intervals of silence before a device is called offline: one late beat is not an absence. */
const ALLOWANCE = 2.5;
/** Never sooner than this, whatever the interval. */
const MIN_ALLOWANCE_MS = 30_000;
/** Devices watched at most — the topic is anyone's with the integrations account. */
const MAX_WATCHED = 512;

/**
 * A heartbeat payload: the seconds between beats (held to the range above),
 * `'withdrawn'` for an empty one, or null for anything that isn't a whole
 * number of seconds.
 */
export function readHeartbeat(payload: string): number | 'withdrawn' | null {
  const text = payload.trim();
  if (text === '') return 'withdrawn';
  if (!/^\d{1,6}$/.test(text)) return null;
  return Math.min(MAX_HEARTBEAT_SECONDS, Math.max(MIN_HEARTBEAT_SECONDS, Number(text)));
}

export class HeartbeatWatch {
  /** Each watched device's interval, in milliseconds. */
  private readonly every = new Map<string, number>();
  /** When each was last heard live — or, until then, when the hub began listening for it. */
  private readonly heard = new Map<string, number>();
  /** Devices already reported quiet, so a silence is reported once. */
  private readonly quiet = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * The device said how often it speaks. `live` is false for a retained copy.
   * True when this was the device speaking after it had been reported quiet.
   */
  declare(deviceId: string, seconds: number, live: boolean): boolean {
    if (!this.every.has(deviceId) && this.every.size >= MAX_WATCHED) return false;
    this.every.set(deviceId, seconds * 1000);
    if (!this.heard.has(deviceId)) this.heard.set(deviceId, this.now());
    return this.heardFrom(deviceId, live);
  }

  /**
   * Anything else the device published. True when it had been reported quiet
   * and this, arriving live, says it is there after all.
   */
  heardFrom(deviceId: string, live: boolean): boolean {
    if (!live || !this.every.has(deviceId)) return false;
    this.heard.set(deviceId, this.now());
    return this.quiet.delete(deviceId);
  }

  /** Its will said it went: already offline, and nothing for a silence to report. */
  wentOffline(deviceId: string): void {
    if (this.every.has(deviceId)) this.quiet.add(deviceId);
  }

  /** It stopped saying how often it speaks, or it was deleted: it is no longer judged. */
  forget(deviceId: string): void {
    this.every.delete(deviceId);
    this.heard.delete(deviceId);
    this.quiet.delete(deviceId);
  }

  /**
   * The connection to the broker began again, and every retained message —
   * an `online` that may be stale among them — is about to arrive once more.
   * Each device gets its full allowance from now, and may be reported again.
   */
  restart(): void {
    const now = this.now();
    for (const deviceId of this.every.keys()) this.heard.set(deviceId, now);
    this.quiet.clear();
  }

  /** The devices that have been silent past their allowance, each reported once. */
  sweep(): string[] {
    const now = this.now();
    const silent: string[] = [];
    for (const [deviceId, every] of this.every) {
      if (this.quiet.has(deviceId)) continue;
      const since = this.heard.get(deviceId) ?? now;
      if (now - since > Math.max(ALLOWANCE * every, MIN_ALLOWANCE_MS)) {
        this.quiet.add(deviceId);
        silent.push(deviceId);
      }
    }
    return silent;
  }
}
