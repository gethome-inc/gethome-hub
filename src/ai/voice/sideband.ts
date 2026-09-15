import WebSocket from 'ws';
import type { Logger } from '../../logging.js';
import { liveSidebandUrl, SIDEBAND_MAX_SECONDS } from './live-wire.js';
import { VoiceDelegation, type VoiceDelegationHost } from './delegation.js';

/**
 * The hub's own connection to a live voice session, beside the phone's.
 *
 * **This is where the delegation loop belongs, and it took three goes to see
 * it.** GPT-Live's client delegation says "I need help" and nothing else, so
 * somebody has to assemble the request from the transcript and answer it. That
 * was the phone, which meant every spoken request went OpenAI → phone → hub →
 * phone → OpenAI: two LAN legs added to the one thing on this surface that is
 * measured in how quickly a lamp goes off. A **sideband** attaches a second
 * connection to the *same* session from here, so the request never leaves the
 * machine that can answer it.
 *
 * **This file is only the socket.** What the frames mean — the delegations, the
 * transcript, the usage, and the audio that is dropped before it is parsed —
 * is `VoiceDelegation` in `delegation.ts`, for the reason `settling.ts` is its
 * own file next door to `@matter/main`: reading those rules through this one
 * means dialling `api.openai.com`, so they would be rules no test could reach.
 * Here: attach, hand every frame over, put a frame on the wire when asked, and
 * make sure what the line cost is written down however the connection ended.
 *
 * **And nothing here parses a frame on its way through**, which was justified
 * for a while by a claim that turned out to be wrong: that a sideband is sent
 * copies of the audio in both directions, a megabit a second of base64 PCM16,
 * with no way to decline it. It is not — those two events are WebSocket-only
 * and a WebRTC session's media never becomes JSON at all (`LIVE_AUDIO_EVENTS`
 * has the correction). The prefix scan in `VoiceDelegation.read` still earns
 * its place on the transcript deltas, which really do arrive several times a
 * second and are mostly of no interest to this side.
 */

export type { VoiceDelegationHost as VoiceSidebandHost } from './delegation.js';

export interface VoiceSidebandOptions {
  /** OpenAI's own id for the live session, from the creation response. */
  liveSessionId: string;
  /** The assistant conversation this session writes into. */
  sessionId: string;
  /** Whose conversation it is — the member whose phone is holding the audio. */
  memberId: string;
  /** The home's OpenAI key. Used to attach and never returned. */
  secret: string;
  host: VoiceDelegationHost;
  log: Logger;
}

/** The ceiling, in the units a timer takes. `live-wire.ts` owns the number,
 *  because what is billed is clamped to the same one. */
const SIDEBAND_MAX_MS = SIDEBAND_MAX_SECONDS * 1000;

export class VoiceSideband {
  private socket: WebSocket | undefined;
  private ceiling: NodeJS.Timeout | undefined;
  private readonly delegation: VoiceDelegation;

  constructor(private readonly options: VoiceSidebandOptions) {
    this.delegation = new VoiceDelegation({
      sessionId: options.sessionId,
      memberId: options.memberId,
      host: options.host,
      log: options.log,
      send: (frame) => this.put(frame),
      close: () => this.close(),
    });
  }

  /**
   * Attach to the running session.
   *
   * Nothing is sent to configure it: the session was created over HTTP with
   * the whole configuration, and the API is explicit that an attached socket
   * must not send `session.start` again.
   */
  attach(): void {
    if (this.socket) return;
    const socket = new WebSocket(liveSidebandUrl(this.options.liveSessionId), {
      headers: { authorization: `Bearer ${this.options.secret}` },
    });
    this.socket = socket;

    socket.on('message', (data: WebSocket.RawData) => {
      this.delegation.read(typeof data === 'string' ? data : data.toString('utf8'));
    });
    socket.on('error', (error: Error) => {
      this.options.log.warn({ error }, 'voice: the sideband failed');
    });
    socket.on('close', () => {
      // The last usage we saw is the honest answer: the API's own advice for a
      // connection that ends before `session.closed`.
      void this.delegation.settle();
    });

    this.ceiling = setTimeout(() => {
      this.options.log.warn('voice: a sideband outlived its ceiling');
      this.close();
    }, SIDEBAND_MAX_MS);
    this.ceiling.unref?.();
  }

  close(): void {
    if (this.ceiling) clearTimeout(this.ceiling);
    this.ceiling = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    void this.delegation.settle();
  }

  /** A frame on the wire, or nothing at all if the line has gone. */
  private put(frame: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(frame));
  }
}

/**
 * The sidebands this process is holding, one per live voice session.
 *
 * **A module-level registry rather than a service threaded through `ApiDeps`**,
 * and that is a deliberate trade. One hub is one home and one process, so
 * there is exactly one of these however it is passed; and every field added to
 * `ApiDeps` is a field two `buildServer` call sites in `test/` have to learn
 * about — which has already cost this repository a CI failure that read as
 * `list.map is not a function` a hundred lines from its cause. What is stored
 * is a socket per *open conversation*, closed when the session ends and
 * replaced when one is reopened, so it cannot grow.
 */
const attached = new Map<string, VoiceSideband>();

/** Attach one, replacing any this conversation was already holding. */
export function attachSideband(options: VoiceSidebandOptions): void {
  attached.get(options.sessionId)?.close();
  const sideband = new VoiceSideband(options);
  attached.set(options.sessionId, sideband);
  sideband.attach();
}

/** Let one go — the hub shutting down, or a conversation being closed. */
export function detachSideband(sessionId: string): void {
  attached.get(sessionId)?.close();
  attached.delete(sessionId);
}

/** Let all of them go. For shutdown, and for a suite that opened one. */
export function detachAllSidebands(): void {
  for (const sideband of attached.values()) sideband.close();
  attached.clear();
}
