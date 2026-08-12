import type { Logger } from '../logging.js';

/**
 * The most a single Zigbee permit-join grant can last. It is a protocol limit,
 * not a Zigbee2MQTT one — the duration travels as a uint8 of seconds — so a
 * window longer than this is *several* grants, not one long one.
 */
export const MAX_GRANT_SECONDS = 254;

/** What the apps open by default. Long enough to walk to the device, find the
 *  reset hole and hold a paperclip in it. */
export const DEFAULT_WINDOW_SECONDS = 300;

/** The most a caller may ask for. Joining is the one moment a home's network
 *  accepts strangers; "until I say stop" is not something to offer by accident. */
export const MAX_WINDOW_SECONDS = 900;

/** Renew a grant when this little of it is left. */
const RENEW_WHEN_UNDER_SECONDS = 20;

/** How often the countdown is republished while the window is open. */
const HEARTBEAT_MS = 5_000;

/**
 * Zigbee2MQTT publishes `bridge/info` on change, so the `permit_join: false`
 * that was true a moment ago can arrive just after we opened the window. A
 * grant is only overruled by a report that is newer than it.
 */
const REPORT_GRACE_MS = 3_000;

export interface PermitJoinState {
  active: boolean;
  remainingSeconds: number;
}

/** The half of the Zigbee adapter this needs — nothing else. */
export interface PermitJoinRadio {
  permitJoin(seconds: number): Promise<void>;
}

/** The fields of Zigbee2MQTT's `bridge/info` that describe the join window.
 *  `permit_join_end` is current (epoch **seconds**); `permit_join_timeout`
 *  is what older versions published (seconds remaining). */
export interface BridgePermitJoinReport {
  permit_join?: boolean;
  permit_join_end?: number;
  permit_join_timeout?: number;
}

/**
 * Owns "is the network open, and for how much longer".
 *
 * The hub used to answer neither. `POST /zigbee/permit-join` published one
 * grant, emitted one event and forgot, so nothing counted down, nothing said
 * the window had closed, and `GET /hub` didn't carry the state at all — a
 * client that reconnected had no way to learn it. GetHome Studio's button
 * therefore read "Close Network" forever while the network had in fact closed
 * two minutes earlier, which is worse than not showing the state: the app was
 * confidently wrong about the one thing that screen exists to report.
 *
 * Three rules:
 *
 *  - **A window is made of grants.** The protocol caps one grant at 254 s
 *    (`MAX_GRANT_SECONDS`), so a five-minute window is re-issued, and the last
 *    grant is *sized to land exactly on the deadline* rather than overshooting
 *    it. Asking for the wrong thing here would leave the network open past the
 *    moment the user was told it would shut.
 *  - **Zigbee2MQTT is the authority, not our timer.** `bridge/info` reports
 *    what the coordinator is actually doing; a `permit_join: false` newer than
 *    our last grant closes the window whatever we intended, because Z2M knows
 *    about restarts and radio failures and we don't.
 *  - **It fails closed.** A hub that restarts mid-window leaves at most one
 *    grant running, and nothing renews it.
 */
export class PermitJoinService {
  private deadlineAt: number | null = null;
  private grantUntil = 0;
  private lastGrantAt = 0;
  private lastEmitted: PermitJoinState = { active: false, remainingSeconds: 0 };
  private lastHeartbeat = 0;
  private timer: NodeJS.Timeout | undefined;

  private radio: PermitJoinRadio | undefined;

  constructor(
    radio: PermitJoinRadio | undefined,
    private readonly log: Logger,
    private readonly onChange: (state: PermitJoinState) => void,
  ) {
    this.radio = radio;
  }

  /**
   * Hand over the radio after construction.
   *
   * The two need each other: the adapter reports `bridge/info` *to* this
   * service, and this service publishes `permit_join` *through* the adapter.
   * Something has to be built first, and a setter is a smaller price than a
   * lazy getter or a shared mutable box.
   */
  useRadio(radio: PermitJoinRadio): void {
    this.radio = radio;
  }

  get state(): PermitJoinState {
    const remaining = this.remainingSeconds();
    return remaining > 0 ? { active: true, remainingSeconds: remaining } : { active: false, remainingSeconds: 0 };
  }

  /** Open the network for `seconds` (0 closes it). Returns the resulting state. */
  async open(seconds: number): Promise<PermitJoinState> {
    if (!this.radio) throw new Error('Zigbee is not enabled');
    const window = Math.min(Math.max(0, Math.trunc(seconds)), MAX_WINDOW_SECONDS);
    if (window === 0) {
      await this.close();
      return this.state;
    }
    this.deadlineAt = Date.now() + window * 1000;
    await this.grant(Math.min(window, MAX_GRANT_SECONDS));
    this.startTicking();
    this.emit(true);
    return this.state;
  }

  async close(): Promise<void> {
    this.deadlineAt = null;
    this.grantUntil = 0;
    this.stopTicking();
    if (this.radio) {
      this.lastGrantAt = Date.now();
      await this.radio.permitJoin(0).catch((error: unknown) => {
        this.log.warn({ err: error }, 'Could not close the Zigbee network.');
      });
    }
    this.emit(true);
  }

  /**
   * What Zigbee2MQTT says about the window. Reports older than our most recent
   * grant are ignored — see `REPORT_GRACE_MS`.
   */
  observeBridgeInfo(report: BridgePermitJoinReport): void {
    if (report.permit_join === undefined) return;
    const now = Date.now();
    if (now - this.lastGrantAt < REPORT_GRACE_MS) return;

    if (!report.permit_join) {
      if (this.deadlineAt === null) return;
      this.log.info('Zigbee2MQTT reports the network is closed — ending the join window.');
      this.deadlineAt = null;
      this.grantUntil = 0;
      this.stopTicking();
      this.emit(true);
      return;
    }

    // Z2M says open. Believe its end time as a *ceiling*: our deadline is what
    // the user asked for, and a renewal always sets Z2M's end later than that.
    const reportedEnd =
      report.permit_join_end !== undefined
        ? report.permit_join_end * 1000
        : report.permit_join_timeout !== undefined
          ? now + report.permit_join_timeout * 1000
          : undefined;
    if (reportedEnd !== undefined) this.grantUntil = reportedEnd;
    if (this.deadlineAt === null && reportedEnd !== undefined && reportedEnd > now) {
      // Somebody opened the network from outside the hub (Z2M's own UI, an
      // MQTT client). Adopt it rather than reporting a closed network while
      // devices are joining.
      this.deadlineAt = reportedEnd;
      this.startTicking();
      this.emit(true);
    }
  }

  stop(): void {
    this.stopTicking();
  }

  private remainingSeconds(): number {
    if (this.deadlineAt === null) return 0;
    return Math.max(0, Math.ceil((this.deadlineAt - Date.now()) / 1000));
  }

  private async grant(seconds: number): Promise<void> {
    if (!this.radio) return;
    this.lastGrantAt = Date.now();
    this.grantUntil = this.lastGrantAt + seconds * 1000;
    await this.radio.permitJoin(seconds);
  }

  private startTicking(): void {
    if (this.timer) return;
    const timer = setInterval(() => this.tick(), 1000);
    timer.unref?.();
    this.timer = timer;
    this.lastHeartbeat = 0;
  }

  private stopTicking(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private tick(): void {
    const remaining = this.remainingSeconds();
    if (remaining <= 0) {
      if (this.deadlineAt !== null) {
        this.deadlineAt = null;
        this.grantUntil = 0;
        this.stopTicking();
        this.emit(true);
      }
      return;
    }

    const now = Date.now();
    const grantLeft = Math.max(0, Math.ceil((this.grantUntil - now) / 1000));
    // Renew only while the window outlasts the grant. The last grant is sized
    // to the remainder, so it expires on the deadline instead of past it.
    if (grantLeft <= RENEW_WHEN_UNDER_SECONDS && remaining > grantLeft) {
      const next = Math.min(remaining, MAX_GRANT_SECONDS);
      void this.grant(next).catch((error: unknown) => {
        this.log.warn({ err: error }, 'Could not extend the Zigbee join window.');
      });
    }

    if (now - this.lastHeartbeat >= HEARTBEAT_MS) this.emit(true);
  }

  private emit(force = false): void {
    const state = this.state;
    if (
      !force &&
      state.active === this.lastEmitted.active &&
      state.remainingSeconds === this.lastEmitted.remainingSeconds
    ) {
      return;
    }
    this.lastEmitted = state;
    this.lastHeartbeat = Date.now();
    this.onChange(state);
  }
}
