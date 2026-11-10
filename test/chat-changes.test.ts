import { describe, expect, it } from 'vitest';
import { emptyState, type EndpointState, type HubCommand } from '../src/schema/index.js';
import {
  changesOf,
  commandAsSet,
  commandBefore,
  commandHolds,
  mergeChange,
  undoVerdict,
  MAX_ROUND_CHANGES,
  type ChatChangeWire,
} from '../src/ai/chat/changes.js';

/**
 * What a reply changed, as two commands — the one that went out and the one
 * that would put the device back — and when putting it back is allowed.
 */

const state = (patch: Partial<EndpointState>): EndpointState => ({ ...emptyState(), ...patch });

const change = (set: HubCommand, before?: HubCommand): ChatChangeWire => ({
  deviceId: 'd',
  endpointId: 1,
  name: 'Device',
  at: '2026-11-10T10:00:00.000Z',
  set,
  ...(before !== undefined ? { before } : {}),
});

describe('what it was before', () => {
  it('is the command that would put it back', () => {
    expect(commandBefore({ type: 'power', on: true }, state({ onOff: false }))).toEqual({ type: 'power', on: false });
    expect(
      commandBefore({ type: 'setLevel', level: 20 }, state({ level: { current: 180, min: 1, max: 254 } })),
    ).toEqual({ type: 'setLevel', level: 180 });
    // Opening or closing a blind is undone by its old position, not by the opposite word.
    expect(
      commandBefore(
        { type: 'openCovering' },
        state({ covering: { currentPositionLiftPercent100ths: 6500, isMoving: false } }),
      ),
    ).toEqual({ type: 'setCoveringPercent', percent100ths: 6500 });
    expect(commandBefore({ type: 'lock', engage: true }, state({ lock: 2 }))).toEqual({ type: 'lock', engage: false });
  });

  it('is absent rather than guessed when the device never said', () => {
    expect(commandBefore({ type: 'power', on: true }, state({}))).toBeUndefined();
    expect(commandBefore({ type: 'power', on: true }, undefined)).toBeUndefined();
    // "Not fully locked" is neither state, so not one to return to.
    expect(commandBefore({ type: 'lock', engage: true }, state({ lock: 0 }))).toBeUndefined();
    // Nothing stands behind a stop or an IR code.
    expect(commandBefore({ type: 'stopCovering' }, state({}))).toBeUndefined();
    expect(commandBefore({ type: 'irSend', commandId: 'x' }, state({}))).toBeUndefined();
  });

  it('writes a toggle down as the power it came to', () => {
    expect(commandAsSet({ type: 'toggle' }, { type: 'power', on: true })).toEqual({ type: 'power', on: false });
    expect(commandAsSet({ type: 'toggle' }, undefined)).toEqual({ type: 'toggle' });
  });
});

describe('whether it may be put back', () => {
  const dimmed = change({ type: 'setLevel', level: 40 }, { type: 'setLevel', level: 200 });

  it('is, while the device is still the way the reply left it — give or take a step', () => {
    expect(undoVerdict(dimmed, state({ level: { current: 41, min: 1, max: 254 } }))).toBeNull();
    expect(commandHolds({ type: 'setLevel', level: 40 }, state({ level: { current: 41, min: 1, max: 254 } }))).toBe(true);
  });

  it('is not, once it has been changed again, or says nothing', () => {
    expect(undoVerdict(dimmed, state({ level: { current: 90, min: 1, max: 254 } }))).toBe('changed_since');
    expect(undoVerdict(dimmed, state({}))).toBe('changed_since');
    expect(undoVerdict(dimmed, undefined)).toBe('changed_since');
  });

  it('says so when it is already as it was', () => {
    expect(undoVerdict(dimmed, state({ level: { current: 200, min: 1, max: 254 } }))).toBe('already_as_before');
  });

  it('never unlocks, whatever the lock says now', () => {
    const locked = change({ type: 'lock', engage: true }, { type: 'lock', engage: false });
    for (const lock of [0, 1, 2] as const) expect(undoVerdict(locked, state({ lock }))).toBe('lock');
    // The other direction is an ordinary undo.
    const unlocked = change({ type: 'lock', engage: false }, { type: 'lock', engage: true });
    expect(undoVerdict(unlocked, state({ lock: 2 }))).toBeNull();
  });

  it('cannot put back what it never knew', () => {
    expect(undoVerdict(change({ type: 'power', on: true }), state({ onOff: true }))).toBe('no_before');
  });

  it('counts a blind still on its way as where it was sent', () => {
    const closed = change({ type: 'closeCovering' }, { type: 'setCoveringPercent', percent100ths: 0 });
    expect(
      undoVerdict(
        closed,
        state({
          covering: {
            currentPositionLiftPercent100ths: 4200,
            targetPositionLiftPercent100ths: 10_000,
            isMoving: true,
          },
        }),
      ),
    ).toBeNull();
  });
});

describe('a round’s list', () => {
  it('is bounded, and reads back only what is a change', () => {
    let list: ChatChangeWire[] = [];
    for (let index = 0; index < MAX_ROUND_CHANGES + 5; index += 1) {
      list = mergeChange(list, { ...change({ type: 'power', on: true }), deviceId: `d${index}` });
    }
    expect(list).toHaveLength(MAX_ROUND_CHANGES);
    expect(changesOf({ changes: [list[0], 'junk', { deviceId: 1 }] })).toEqual([list[0]]);
    expect(changesOf(null)).toEqual([]);
  });
});
