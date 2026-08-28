import mqtt from 'mqtt';
import { StringDecoder } from 'node:string_decoder';
import type { Logger } from '../logging.js';
import { brokerCredentials } from '../mqtt-auth.js';

/**
 * Which conversation a message belongs to. The apps group by this rather than
 * by topic string, so a base topic somebody renamed doesn't change the UI.
 */
export type MqttChannel = 'zigbee-device' | 'zigbee-bridge' | 'gethome' | 'other';

export interface MqttFrame {
  /** Monotonic within one observer run — the apps key their rows on it. */
  seq: number;
  at: string;
  topic: string;
  channel: MqttChannel;
  /** Whether the hub published this, or something else did. */
  direction: 'in' | 'out';
  payload: string;
  /** The payload was longer than `MAX_PAYLOAD_BYTES` and is cut. */
  truncated: boolean;
  /**
   * What the whole message weighed, cut or not.
   *
   * Without it a client can only say "this was cut", which leaves the reader
   * unable to tell a payload missing fifty bytes from one missing three
   * megabytes — and forces the app to name our limit, a number from another
   * repository that goes stale the moment it changes here.
   */
  payloadBytes: number;
  retained: boolean;
}

export interface MqttObserverOptions {
  mqttUrl: string;
  /**
   * Broker credentials, when the broker asks for them. Empty on a hub
   * installed before `install.sh` started minting them — the drop-in it
   * writes then still says `allow_anonymous true`, so an anonymous connect is
   * the correct behaviour rather than a fallback.
   */
  username?: string;
  password?: string;
  z2mBaseTopic: string;
  log: Logger;
  /** Called for every frame, in arrival order. Must not throw. */
  onFrame(frame: MqttFrame): void;
}

/**
 * How much recent traffic a client gets when it starts watching. Bounded by
 * *both* numbers: 300 sensor reports are a few kilobytes, one `bridge/devices`
 * on a large network is hundreds, and a cap in rows alone would let the second
 * kind hold megabytes on a board with 512 MB.
 */
const MAX_FRAMES = 300;
const MAX_BUFFER_BYTES = 256 * 1024;

/**
 * The most of one message an inspector is shown.
 *
 * It was 2 KB, which cut the wrong things. Everything somebody actually reads
 * here is small — a device report is a few hundred bytes, and `bridge/info`,
 * `bridge/event` and `bridge/health` are one to three kilobytes — so the old
 * limit sat right in the middle of the useful range and cut messages that had
 * only just started being interesting. 8 KB clears all of them whole.
 *
 * What stays cut is the pair of retained registries, `bridge/devices` and
 * `bridge/definitions`, and that is deliberate rather than regrettable: they
 * are hundreds of kilobytes to megabytes of reference data, they are not
 * traffic anybody watches go past, and holding one costs a Zero 2 W real
 * memory on a subscription that exists only to be looked at. `payloadBytes`
 * is what makes that honest — the app says how much of the message it has,
 * instead of asserting a number from this file.
 */
const MAX_PAYLOAD_BYTES = 8192;

/**
 * How long the broker connection outlives the last watcher. Switching to
 * another tab and back is the common case, and tearing the subscription down
 * on the way out would clear the log every time.
 */
const LINGER_MS = 60_000;

/**
 * A read-only tap on the hub's MQTT broker, for the apps' traffic inspector.
 *
 * Three things about it are deliberate, and all three are about a Zero 2 W:
 *
 *  - **It exists only while somebody is watching.** `attach()`/`detach()` are
 *    reference-counted, so a hub nobody has open pays for no third connection,
 *    no buffer and no wildcard subscription. The adapters' own clients stay
 *    narrow (`gethome/#`, `<base>/#`); this is the only thing that ever
 *    subscribes to `#`, and it is transient.
 *  - **Nothing it sees is written down.** Traffic is a stream a person watches,
 *    not a record — one row per sensor report onto an SD card is exactly what
 *    the registry's state debounce exists to avoid. History before the first
 *    watcher does not exist, and the apps say so rather than implying otherwise.
 *  - **The buffer is bounded in bytes.** See `MAX_BUFFER_BYTES`.
 *
 * It also never feeds anything but the UI: the AI mapper's only input is a
 * device entry from `bridge/devices`, and this class has no reference to it.
 * See docs/ai-adaptation.md ("What is never sent").
 */
export class MqttObserver {
  private client: mqtt.MqttClient | null = null;
  private watchers = 0;
  private lingerTimer: NodeJS.Timeout | undefined;
  private seq = 0;
  private buffer: MqttFrame[] = [];
  private bufferBytes = 0;
  private readonly base: string;

  constructor(private readonly options: MqttObserverOptions) {
    this.base = options.z2mBaseTopic.replace(/\/+$/, '');
  }

  get watching(): boolean {
    return this.watchers > 0;
  }

  /** Start (or keep) the tap. Never throws — a broker that is down is a quiet
   *  inspector, not a failed request. */
  attach(): void {
    this.watchers += 1;
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = undefined;
    }
    if (this.client) return;
    this.connect();
  }

  detach(): void {
    this.watchers = Math.max(0, this.watchers - 1);
    if (this.watchers > 0 || this.lingerTimer) return;
    const timer = setTimeout(() => {
      this.lingerTimer = undefined;
      if (this.watchers > 0) return;
      this.disconnect();
    }, LINGER_MS);
    timer.unref?.();
    this.lingerTimer = timer;
  }

  /** The tail of what has arrived since the tap opened, oldest first. */
  recent(limit = MAX_FRAMES): MqttFrame[] {
    if (limit >= this.buffer.length) return [...this.buffer];
    return this.buffer.slice(this.buffer.length - Math.max(0, limit));
  }

  /** Shut everything down regardless of the watcher count (process exit). */
  async stop(): Promise<void> {
    this.watchers = 0;
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = undefined;
    }
    const client = this.client;
    this.client = null;
    this.buffer = [];
    this.bufferBytes = 0;
    await client?.endAsync().catch(() => undefined);
  }

  private connect(): void {
    // `connect` rather than `connectAsync`: this is an optional tap on an
    // optional broker, and a caller that opened a tab must not be left waiting
    // on a TCP handshake — nor have a rejected promise to handle.
    const client = mqtt.connect(this.options.mqttUrl, {
      clientId: `gethome-hub-observer-${Math.random().toString(16).slice(2, 8)}`,
      reconnectPeriod: 5000,
      ...brokerCredentials(this.options),
    });
    this.client = client;
    client.on('connect', () => {
      client.subscribe('#', { qos: 0 }, (error) => {
        if (error) this.options.log.warn({ err: error }, 'MQTT observer could not subscribe.');
      });
    });
    client.on('error', (error) => {
      this.options.log.debug({ err: error }, 'MQTT observer connection error.');
    });
    client.on('message', (topic, payload, packet) => {
      try {
        this.ingest(topic, payload, packet.retain === true);
      } catch (error) {
        this.options.log.debug({ err: error, topic }, 'MQTT observer dropped a frame.');
      }
    });
  }

  private disconnect(): void {
    const client = this.client;
    this.client = null;
    this.buffer = [];
    this.bufferBytes = 0;
    void client?.endAsync().catch(() => undefined);
    this.options.log.debug('MQTT observer released — nobody is watching.');
  }

  /**
   * Classify, bound and publish one message. Public as a test seam: the
   * buffer's limits and the topic classification are the whole behaviour worth
   * pinning, and reaching them through a live broker would test mosquitto.
   */
  ingest(topic: string, payload: Buffer, retained = false): void {
    const truncated = payload.byteLength > MAX_PAYLOAD_BYTES;
    const text = truncated ? cutToCharacter(payload, MAX_PAYLOAD_BYTES) : payload.toString('utf8');
    this.seq += 1;
    const frame: MqttFrame = {
      seq: this.seq,
      at: new Date().toISOString(),
      topic,
      channel: this.classify(topic),
      direction: this.direction(topic),
      payload: text,
      truncated,
      payloadBytes: payload.byteLength,
      retained,
    };
    this.push(frame);
    this.options.onFrame(frame);
  }

  private push(frame: MqttFrame): void {
    const weight = frameBytes(frame);
    this.buffer.push(frame);
    this.bufferBytes += weight;
    while (this.buffer.length > MAX_FRAMES || this.bufferBytes > MAX_BUFFER_BYTES) {
      const dropped = this.buffer.shift();
      if (!dropped) break;
      this.bufferBytes -= frameBytes(dropped);
    }
  }

  private classify(topic: string): MqttChannel {
    if (topic === this.base || topic.startsWith(`${this.base}/`)) {
      return topic.startsWith(`${this.base}/bridge/`) || topic === `${this.base}/bridge`
        ? 'zigbee-bridge'
        : 'zigbee-device';
    }
    if (topic === 'gethome' || topic.startsWith('gethome/')) return 'gethome';
    return 'other';
  }

  /**
   * Who published this, worked out from the topic rather than from watching our
   * own clients. A broker delivers a message to every subscriber including the
   * publisher, so the tap sees the hub's own writes — and the topic already
   * says which they are: only the hub writes `/set`, `/get` and
   * `bridge/request/*`.
   */
  private direction(topic: string): 'in' | 'out' {
    if (topic.startsWith(`${this.base}/bridge/request/`)) return 'out';
    if (topic.endsWith('/set') || topic.endsWith('/get')) return 'out';
    if (/\/set\/\d+$/.test(topic)) return 'out';
    return 'in';
  }
}

/**
 * The first `limit` bytes, ending on a whole character.
 *
 * `buffer.subarray(0, n).toString('utf8')` cuts by *bytes*, so a limit landing
 * inside a multi-byte sequence — every Cyrillic or CJK device name is two or
 * three bytes per character — turns the last one into `U+FFFD`. `StringDecoder`
 * holds an incomplete sequence back instead of guessing at it, and never
 * calling `end()` is what drops it: the payload is being cut anyway, and one
 * missing character at the cut is better than one wrong one.
 */
function cutToCharacter(payload: Buffer, limit: number): string {
  return new StringDecoder('utf8').write(payload.subarray(0, limit));
}

/**
 * What a frame costs the buffer, in bytes rather than in UTF-16 units.
 *
 * `String.length` counts units, so it under-reports every non-Latin payload by
 * up to a factor of three — on a Cyrillic-named network the byte ceiling this
 * exists to enforce was quietly two to three times higher than it reads.
 */
function frameBytes(frame: MqttFrame): number {
  return Buffer.byteLength(frame.payload) + Buffer.byteLength(frame.topic);
}
