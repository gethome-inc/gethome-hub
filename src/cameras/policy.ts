import { z } from 'zod';

/**
 * What the hub will fetch a camera stream from — the rule that keeps a camera
 * topic from turning the hub into a way into somebody's network.
 *
 * The camera topic is written by a device holding the integrations broker
 * account, which every board in the house shares, so an announcement is
 * untrusted input that names a URL the hub will then request on an app's
 * behalf. That is the shape of a request-forgery hole, and four rules close
 * it: **plain `http:` to an IPv4 literal in a private range** (10/8,
 * 172.16/12, 192.168/16, or link-local 169.254/16) — never a name, which is a
 * lookup somebody else may answer; **never loopback, the unspecified address,
 * multicast or broadcast**, and never one of the hub's own addresses (checked
 * where the request is made, `proxy.ts`); **no credentials in the URL**; and
 * the board has to **prove it is the device** before any stream is relayed
 * (`/gethome/id`, also in `proxy.ts`).
 */

/** A stream as an announcement names it — the URL included, which never leaves the hub. */
export interface CameraStreamSource {
  id: string;
  kind: CameraStreamKind;
  label?: string;
  width?: number;
  height?: number;
  url: string;
}

export const CAMERA_STREAM_KINDS = ['snapshot', 'mjpeg'] as const;
export type CameraStreamKind = (typeof CAMERA_STREAM_KINDS)[number];

/** The most streams one endpoint may announce. */
export const MAX_STREAMS_PER_ENDPOINT = 8;

/** `a.b.c.d` → its four octets, or null for anything that isn't a dotted IPv4 literal. */
export function ipv4Octets(host: string): [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets as [number, number, number, number];
}

/** Private or link-local IPv4 — the addresses a camera in the house has. */
export function isPrivateIPv4(host: string): boolean {
  const octets = ipv4Octets(host);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * Why a stream URL is refused, or null when the hub may fetch it. The hub's
 * own addresses are a separate check, made where the request is.
 */
export function cameraUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a URL';
  }
  if (url.protocol !== 'http:') return 'only plain http on the home network is allowed';
  if (url.username || url.password) return 'credentials in a camera URL are refused';
  if (!isPrivateIPv4(url.hostname)) return 'the address must be a private IPv4 address on the home network';
  return null;
}

const announcedStreamSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  kind: z.string().min(1).max(24),
  label: z.string().max(60).optional(),
  width: z.number().int().min(1).max(10_000).optional(),
  height: z.number().int().min(1).max(10_000).optional(),
  url: z.string().min(1).max(512),
});

/**
 * Reads what a camera announced, **leniently**: a stream this hub doesn't
 * understand — a newer kind, a bad URL, a field out of range — is dropped
 * on its own rather than taking the announcement with it, and a field it has
 * never heard of is ignored. A newer device library must not make a camera
 * disappear from an older hub. Returns what was kept and why the rest wasn't.
 */
export function readCameraAnnouncement(raw: unknown): { streams: CameraStreamSource[]; dropped: string[] } {
  const streams: CameraStreamSource[] = [];
  const dropped: string[] = [];
  const list = typeof raw === 'object' && raw !== null && Array.isArray((raw as { streams?: unknown }).streams)
    ? ((raw as { streams: unknown[] }).streams)
    : [];
  const seen = new Set<string>();
  for (const candidate of list) {
    if (streams.length >= MAX_STREAMS_PER_ENDPOINT) {
      dropped.push('more than 8 streams');
      break;
    }
    const parsed = announcedStreamSchema.safeParse(candidate);
    if (!parsed.success) {
      dropped.push('a stream that is not well formed');
      continue;
    }
    const stream = parsed.data;
    if (!(CAMERA_STREAM_KINDS as readonly string[]).includes(stream.kind)) {
      dropped.push(`stream "${stream.id}" is a kind this hub doesn't serve (${stream.kind})`);
      continue;
    }
    const problem = cameraUrlProblem(stream.url);
    if (problem) {
      dropped.push(`stream "${stream.id}": ${problem}`);
      continue;
    }
    if (seen.has(stream.id)) continue;
    seen.add(stream.id);
    streams.push({
      id: stream.id,
      kind: stream.kind as CameraStreamKind,
      url: stream.url,
      ...(stream.label !== undefined ? { label: stream.label } : {}),
      ...(stream.width !== undefined ? { width: stream.width } : {}),
      ...(stream.height !== undefined ? { height: stream.height } : {}),
    });
  }
  return { streams, dropped };
}

/** A stream as an app sees it: everything but the address. */
export function publicStream(stream: CameraStreamSource): {
  id: string;
  kind: string;
  label?: string;
  width?: number;
  height?: number;
} {
  return {
    id: stream.id,
    kind: stream.kind,
    ...(stream.label !== undefined ? { label: stream.label } : {}),
    ...(stream.width !== undefined ? { width: stream.width } : {}),
    ...(stream.height !== undefined ? { height: stream.height } : {}),
  };
}
