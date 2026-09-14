import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AutomationHomeView } from '../src/automations/targets.js';
import type { ChatMessageWire } from '../src/ai/chat/chat-runtime.js';
import { liveHistory, liveInstructions } from '../src/ai/voice/prompts.js';
import { LIVE_HISTORY_MESSAGES } from '../src/ai/voice/live-wire.js';

/**
 * The two halves of the voice prompt that are pure functions, which is most of
 * what is testable about this surface at all: everything else on it is an
 * audio socket the suite cannot dial.
 *
 * Both assertions are about a rule that has already been got wrong once. The
 * instructions used to carry the whole home as JSON — device ids, endpoint
 * numbers, capability lists — copied from the assistant's own prompt, and
 * under client delegation the voice has no tools and so nothing it could ever
 * do with any of it. And a session continuing a typed conversation has to open
 * knowing what was said without inheriting a page's own interaction rows,
 * which read as nonsense out loud.
 */

const kitchenId = randomUUID();
const lightId = randomUUID();
const plugId = randomUUID();

function home(): AutomationHomeView {
  return {
    rooms: [{ id: kitchenId, name: 'Kitchen', zoneId: null }],
    zones: [],
    automations: [],
    devices: [
      {
        id: lightId,
        name: 'Ceiling light',
        roomId: kitchenId,
        online: true,
        endpoints: [{ endpointId: 1, deviceKind: 'light', capabilities: ['onOff', 'level'] }],
      },
      {
        id: plugId,
        name: 'Heater plug',
        roomId: null,
        online: true,
        endpoints: [{ endpointId: 1, deviceKind: 'outlet', capabilities: ['onOff'] }],
      },
    ],
  };
}

describe('the voice prompt', () => {
  it('names the home and nothing a spoken answer could not use', () => {
    const prompt = liveInstructions({ home: home(), timezone: 'Europe/London', personName: 'Ada' });

    // The names, which is what it is for: hearing "the kitchen one" and saying
    // it back. A device with no room is named alone rather than parenthesised
    // against nothing.
    expect(prompt).toContain('Ceiling light (Kitchen)');
    expect(prompt).toContain('Heater plug');
    expect(prompt).not.toContain('Heater plug (');
    expect(prompt).toContain('Europe/London');
    expect(prompt).toContain('Ada');

    // And none of the machinery. An id cannot be spoken, an endpoint number
    // cannot be acted on from here, and a capability list is the backend's
    // business — this is the assertion that keeps the assistant's prompt from
    // being copied back in.
    expect(prompt).not.toContain(lightId);
    expect(prompt).not.toContain(plugId);
    expect(prompt).not.toContain(kitchenId);
    expect(prompt).not.toContain('endpointId');
    expect(prompt).not.toContain('onOff');
  });

  it('opens on what was said, not on what a page did', () => {
    const rows: ChatMessageWire[] = [
      { id: '1', at: '2026-09-14T10:00:00.000Z', role: 'user', text: 'is the heater on?' },
      { id: '2', at: '2026-09-14T10:00:01.000Z', role: 'agent', text: 'No, it is off.' },
      { id: '3', at: '2026-09-14T10:00:02.000Z', role: 'question', text: 'Which heater?' },
      { id: '4', at: '2026-09-14T10:00:03.000Z', role: 'handoff', text: 'Automations agent' },
      { id: '5', at: '2026-09-14T10:00:04.000Z', role: 'preview', text: 'Evening' },
      { id: '6', at: '2026-09-14T10:00:05.000Z', role: 'note', text: 'This home has no hub.' },
    ];

    expect(liveHistory(rows)).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'is the heater on?' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'No, it is off.' }],
      },
    ]);
  });

  it('keeps the newest exchanges and drops the fortnight behind them', () => {
    const rows: ChatMessageWire[] = Array.from({ length: 40 }, (_, index) => ({
      id: String(index),
      at: new Date(Date.UTC(2026, 8, 14, 10, 0, index)).toISOString(),
      role: index % 2 === 0 ? ('user' as const) : ('agent' as const),
      text: `line ${index}`,
    }));

    const history = liveHistory(rows);
    expect(history).toHaveLength(LIVE_HISTORY_MESSAGES);
    // Newest last, and the newest is the last thing that was actually said.
    expect(history.at(-1)?.content[0].text).toBe('line 39');
    expect(history[0]?.content[0].text).toBe(`line ${40 - LIVE_HISTORY_MESSAGES}`);
  });
});
