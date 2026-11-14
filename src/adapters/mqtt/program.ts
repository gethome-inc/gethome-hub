/**
 * A device that is a program.
 *
 * Most devices on this convention are hardware: a board with a relay or a
 * sensor on it. Some are a program on a computer — a script, a bridge, a
 * service — that announces itself, reports state and takes commands exactly as
 * a board does, and reads as any other device in the apps. One that wants to
 * be shown for what it is says so on its program topic: a JSON object,
 * retained, which may name the computer it runs on.
 *
 * **A topic of its own, never a key in the discovery document.** That document
 * is checked strictly, so every hub from before this refuses one carrying a
 * key it has never seen, and the device would not appear there at all. A hub
 * from before this does not subscribe to the topic, and the device is an
 * ordinary one to it.
 *
 * **Read leniently, because the object will grow**: a key this hub does not
 * know is passed over, never a reason to refuse. Only what is read here is
 * kept, so nothing a device adds reaches an app unread. And `host` is a name
 * for people — the hub never connects to it.
 */

import type { DeviceProgram } from '../adapter.js';

/** The longest computer name kept, in UTF-16 units; a longer one is cut to this. */
export const MAX_PROGRAM_HOST_LENGTH = 120;

/**
 * A program payload: what the device said about itself, `'withdrawn'` for an
 * empty one (the device is hardware again), or null for anything that isn't a
 * JSON object or whose `host` isn't a string.
 *
 * A `host` is trimmed, and one that is empty afterwards counts as not said —
 * the device is still a program, on a computer it didn't name.
 */
export function readProgram(payload: string): DeviceProgram | 'withdrawn' | null {
  if (payload.trim() === '') return 'withdrawn';
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const host = (json as { host?: unknown }).host;
  if (host === undefined) return {};
  if (typeof host !== 'string') return null;
  const name = cut(host.trim(), MAX_PROGRAM_HOST_LENGTH);
  return name === '' ? {} : { host: name };
}

/** Whether two readings say the same thing, so a device repeating itself changes nothing. */
export function sameProgram(a: DeviceProgram, b: DeviceProgram): boolean {
  return a.host === b.host;
}

/** `text` held to `max` UTF-16 units, without leaving half of a surrogate pair at the end. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
  return text.slice(0, end).trimEnd();
}
