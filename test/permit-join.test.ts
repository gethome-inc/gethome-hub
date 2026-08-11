import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import {
  MAX_GRANT_SECONDS,
  MAX_WINDOW_SECONDS,
  PermitJoinService,
  type PermitJoinState,
} from '../src/core/permit-join.js';

const log = pino({ level: 'silent' });

function build() {
  const grants: number[] = [];
  const states: PermitJoinState[] = [];
  const service = new PermitJoinService(
    { permitJoin: async (seconds: number) => void grants.push(seconds) },
    log,
    (state) => states.push(state),
  );
  return { service, grants, states };
}

describe('PermitJoinService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens a five-minute window with a grant the protocol actually allows', async () => {
    const { service, grants } = build();
    await service.open(300);

    // Not 300: a single permit-join grant is a uint8 of seconds.
    expect(grants).toEqual([MAX_GRANT_SECONDS]);
    expect(service.state).toEqual({ active: true, remainingSeconds: 300 });

    service.stop();
  });

  it('renews the grant, and sizes the last one to land on the deadline', async () => {
    const { service, grants } = build();
    await service.open(300);

    // The first grant is renewed 20 s before it lapses — at t = 234.
    await vi.advanceTimersByTimeAsync(234_000);
    expect(grants).toHaveLength(2);
    // 300 − 234 = 66 seconds of window left, so the second grant is 66 and
    // expires *on* the deadline. Another 254 would leave the network open for
    // three minutes after the countdown the user was shown reached zero.
    expect(grants[1]).toBe(66);

    // Still open a second before the deadline, and not extended again.
    await vi.advanceTimersByTimeAsync(65_000);
    expect(service.state.active).toBe(true);
    expect(grants).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(grants).toHaveLength(2);
    expect(service.state).toEqual({ active: false, remainingSeconds: 0 });

    service.stop();
  });

  it('never renews a window a single grant already covers', async () => {
    const { service, grants } = build();
    await service.open(60);
    expect(grants).toEqual([60]);

    await vi.advanceTimersByTimeAsync(59_000);
    expect(grants).toEqual([60]);

    service.stop();
  });

  it('closes itself when the window runs out, and says so', async () => {
    const { service, states } = build();
    await service.open(30);
    await vi.advanceTimersByTimeAsync(31_000);

    expect(service.state.active).toBe(false);
    expect(states.at(-1)).toEqual({ active: false, remainingSeconds: 0 });

    service.stop();
  });

  it('counts down while it is open', async () => {
    const { service } = build();
    await service.open(120);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(service.state.remainingSeconds).toBe(90);

    service.stop();
  });

  it('publishes a zero grant when closed by hand', async () => {
    const { service, grants } = build();
    await service.open(300);
    await service.close();

    expect(grants.at(-1)).toBe(0);
    expect(service.state).toEqual({ active: false, remainingSeconds: 0 });
  });

  it('treats open(0) as a close', async () => {
    const { service, grants } = build();
    const state = await service.open(0);

    expect(grants).toEqual([0]);
    expect(state.active).toBe(false);
  });

  it('clamps a window nobody should be able to ask for', async () => {
    const { service } = build();
    await service.open(86_400);

    expect(service.state.remainingSeconds).toBe(MAX_WINDOW_SECONDS);

    service.stop();
  });

  it('ignores a bridge report older than the grant it would contradict', async () => {
    const { service } = build();
    await service.open(300);

    // Zigbee2MQTT publishes bridge/info on change, so the "closed" that was
    // true a moment ago can land just after we opened the window.
    service.observeBridgeInfo({ permit_join: false });
    expect(service.state.active).toBe(true);

    service.stop();
  });

  it('closes the window when Zigbee2MQTT says the network is shut', async () => {
    const { service, states } = build();
    await service.open(300);

    await vi.advanceTimersByTimeAsync(5_000);
    service.observeBridgeInfo({ permit_join: false });

    expect(service.state.active).toBe(false);
    expect(states.at(-1)!.active).toBe(false);

    service.stop();
  });

  it('adopts a window somebody opened outside the hub', async () => {
    const { service } = build();
    expect(service.state.active).toBe(false);

    service.observeBridgeInfo({
      permit_join: true,
      permit_join_end: Math.floor(Date.now() / 1000) + 100,
    });

    expect(service.state.active).toBe(true);
    expect(service.state.remainingSeconds).toBeGreaterThan(90);

    service.stop();
  });

  it('reads the older seconds-remaining field too', async () => {
    const { service } = build();
    service.observeBridgeInfo({ permit_join: true, permit_join_timeout: 45 });

    expect(service.state.active).toBe(true);
    expect(service.state.remainingSeconds).toBeGreaterThan(40);

    service.stop();
  });

  it('refuses to open a window with no radio to open it on', async () => {
    const service = new PermitJoinService(undefined, log, () => {});
    await expect(service.open(300)).rejects.toThrow(/not enabled/i);
    expect(service.state).toEqual({ active: false, remainingSeconds: 0 });
  });
});
