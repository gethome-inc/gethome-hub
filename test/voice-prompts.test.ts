import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AutomationHomeView } from '../src/automations/targets.js';
import type { ChatMessageWire } from '../src/ai/chat/chat-runtime.js';
import type { AutomationDocument } from '../src/automations/schema.js';
import type { EndpointState } from '../src/schema/index.js';
import { spokenStateDigest } from '../src/ai/assistant-prompts.js';
import { liveHistory, liveInstructions } from '../src/ai/voice/prompts.js';
import { LIVE_HISTORY_CHARS, LIVE_HISTORY_MESSAGE_CHARS, LIVE_HISTORY_MESSAGES } from '../src/ai/voice/live-wire.js';

/**
 * The two halves of the voice prompt that are pure functions. The rest of what
 * a suite can reach on this surface is in `test/voice-sideband.test.ts`; what
 * neither can reach is the audio, which is the phone's.
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

/** A rule somebody can press, and one the house runs by itself. */
function rule(name: string, pressable: boolean, enabled = true) {
  const triggers = pressable
    ? [{ kind: 'manual' as const }]
    : [{ kind: 'time' as const, at: '23:00' }];
  return {
    id: randomUUID(),
    name,
    enabled,
    document: {
      name,
      triggers,
      actions: [{ kind: 'logActivity' as const, message: name }],
    } as unknown as AutomationDocument,
  };
}

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

  it('keeps the delegation policy labelled, and bounds the names', () => {
    // The prompting guide asks for these labels by name and for concrete
    // conditions rather than "delegate when needed". They are the part of this
    // prompt a future edit would quietly flatten into prose, so they are pinned.
    const prompt = liveInstructions({ home: home(), timezone: 'UTC' });
    expect(prompt).toContain('Backchannel policy:');
    expect(prompt).toContain('Interruption policy:');
    expect(prompt).toContain('Delegation policy:');
    expect(prompt).toContain('Backend tools:');
    expect(prompt).toContain('Delegate to the backend when:');
    expect(prompt).toContain('Do not delegate to the backend when:');

    // And the names are bounded, because the live model's context window is
    // small: a warehouse of smart plugs must not crowd out the policy above it.
    const crowded = home();
    crowded.devices = Array.from({ length: 200 }, (_, index) => ({
      id: randomUUID(),
      name: `Plug ${index}`,
      roomId: null,
      online: true,
      endpoints: [{ endpointId: 1, deviceKind: 'outlet' as const, capabilities: ['onOff'] }],
    }));
    const long = liveInstructions({ home: crowded, timezone: 'UTC' });
    expect(long).toContain('Plug 0');
    expect(long).not.toContain('Plug 199');
  });

  /**
   * **A scene has the same problem a device has and had none of the fix.**
   *
   * The voice cannot run one — under client delegation it has no tools at all
   * — but "put Movie Night on" has to be heard as a *name* rather than as
   * three words, and said back the way the home spells it, which is the whole
   * argument the device names were already carrying. Only the ones somebody
   * could actually ask for: a `watching` rule is something the house does by
   * itself and nobody says its name out loud, and a switched-off rule is not a
   * thing to offer.
   */
  it('names the scenes somebody could ask for, and no others', () => {
    const withRules = home();
    withRules.automations = [
      rule('Movie night', true),
      rule('Goodnight', false),
      rule('Away', true, false),
    ];
    const prompt = liveInstructions({ home: withRules, timezone: 'UTC' });

    expect(prompt).toContain('Movie night');
    // A rule that watches for something, and one switched off.
    expect(prompt).not.toContain('Goodnight');
    expect(prompt).not.toContain('Away');
  });

  /** A home with none grows no heading, rather than an empty one. */
  it('says nothing about scenes in a home that has none', () => {
    expect(liveInstructions({ home: home(), timezone: 'UTC' })).not.toContain('SCENES');
  });

  it('says the names are for hearing rather than for answering', () => {
    // **Caught on a recording of a real conversation.** Asked what scenes the
    // home had, the voice read the list back off these instructions — a list
    // that deliberately leaves out the `watching` rules and the switched-off
    // ones — and said that was all there was. It is a snapshot for
    // pronunciation and the heading says so; the delegation policy has to say
    // it too, because the model is looking at the names and not at the
    // heading.
    const withRules = home();
    withRules.automations = [rule('Movie night', true)];
    const prompt = liveInstructions({ home: withRules, timezone: 'UTC' });

    expect(prompt).toContain('Never answer from them');
    // Every list is hedged, so none of the three reads as the whole home.
    expect(prompt).toContain('SOME ROOMS, BY NAME');
    expect(prompt).toContain('SOME DEVICES, BY NAME');
    expect(prompt).toContain('SOME SCENES AND MODES THEY CAN ASK FOR, BY NAME');
    // And what a still-current result *is* names where it came from, or the
    // list itself reads as one.
    expect(prompt).toContain('A still-current result the backend gave you');
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

  /**
   * The other cap, which a count cannot keep.
   *
   * `session.input` is bounded at 8,192 tokens as well as at 128 messages, and
   * a transcript row holds up to 4,000 characters — so a dozen long answers
   * cleared the count easily and had the session creation refused outright.
   * That failure repeats: the same history is there on the next try, so the
   * microphone stops working on that conversation for good.
   */
  it('keeps the budget as well as the count, dropping the oldest to do it', () => {
    const rows: ChatMessageWire[] = Array.from({ length: 12 }, (_, index) => ({
      id: String(index),
      at: new Date(Date.UTC(2026, 8, 14, 10, 0, index)).toISOString(),
      role: index % 2 === 0 ? ('user' as const) : ('agent' as const),
      // What the transcript itself allows, which is what made this reachable.
      text: `${index}`.padEnd(4_000, 'x'),
    }));

    const history = liveHistory(rows);
    const spent = history.reduce((total, message) => total + message.content[0].text.length, 0);
    expect(spent).toBeLessThanOrEqual(LIVE_HISTORY_CHARS);
    // Every message that survived is clipped rather than whole, and the ones
    // that survived are the newest: the exchange somebody is about to refer to.
    for (const message of history) {
      expect(message.content[0].text.length).toBeLessThanOrEqual(LIVE_HISTORY_MESSAGE_CHARS);
    }
    expect(history.at(-1)?.content[0].text.startsWith('11')).toBe(true);
    expect(history).not.toHaveLength(0);
  });

  it('carries a short conversation whole', () => {
    const rows: ChatMessageWire[] = [
      { id: '1', at: '2026-09-14T10:00:00.000Z', role: 'user', text: 'turn the kettle on' },
      { id: '2', at: '2026-09-14T10:00:01.000Z', role: 'agent', text: 'Done.' },
    ];
    expect(liveHistory(rows).map((message) => message.content[0].text)).toEqual([
      'turn the kettle on',
      'Done.',
    ]);
  });
});

/**
 * What a spoken turn is told about *now*, which the cached first message
 * cannot carry. `assistant-prompts.ts` builds it and `askAloud` puts it on
 * `ChatSession.priming`; it is here because the two voice prompts are the
 * other pure functions on this surface and this is the third.
 */
describe('what everything is doing right now', () => {
  const empty: EndpointState = { reachable: true, sensors: {} };

  function digestOf(states: Record<string, EndpointState>): string | undefined {
    return spokenStateDigest({
      home: home(),
      stateOf: (deviceId) => states[deviceId],
    });
  }

  /**
   * The whole point: "is the kitchen light on" used to be one round to call
   * `get_device` and a second to say the answer, which doubles the term that
   * dominates a spoken exchange on most of what anybody asks a house.
   */
  it('carries what a person asks out loud, keyed by id', () => {
    const digest = digestOf({
      [lightId]: { ...empty, onOff: true, level: { current: 180, min: 1, max: 254 } },
    });

    expect(digest).toContain(lightId);
    expect(digest).toContain('"onOff":true');
    expect(digest).toContain('"level":180');
    // Keyed by id rather than by name, because the first message is already
    // the index and a house with two lamps called "Lamp" must stay unambiguous.
    expect(digest).not.toContain('Ceiling light');
  });

  /**
   * **It has to say that it replaces the tool call, or it buys nothing.**
   *
   * Two other places point the model straight at `get_device` for exactly this
   * — its own description ("before working a device whose exact endpoint or
   * *current value* matters") and the system prompt's *Look before you act* —
   * and both are right for a typed turn. So the digest is directive rather
   * than merely present: the reading is current, a device missing from it is
   * reporting nothing, a plain reading is answered from here, and the things
   * that genuinely still need the tool are named. "Call get_device for
   * anything else" was the first version and it is an invitation.
   */
  it('says it is current, and names what still needs the tool', () => {
    const digest = digestOf({ [lightId]: { ...empty, onOff: true } })!;

    expect(digest).toContain('Current as of this moment');
    expect(digest).toContain('do not call get_device to read a value that is');
    // A device that is simply absent is absent because it reports nothing —
    // not because the digest ran out of room.
    expect(digest).toContain('reporting nothing worth saying');
    // And the gaps are named rather than left as "anything else".
    for (const missing of ['colour', 'limits', 'fan percentage', 'battery that is not low']) {
      expect(digest).toContain(missing);
    }
  });

  /** "Is the heating on?" is a spoken question, and `systemMode` is the field
   *  that answers it — one small int against a whole `get_device` round. */
  it('carries a thermostat’s mode, not only its temperature', () => {
    const digest = digestOf({
      [lightId]: {
        ...empty,
        thermostat: {
          localTemperatureCenti: 2140,
          occupiedHeatingSetpointCenti: 2000,
          heatSetpointMinCenti: 500,
          heatSetpointMaxCenti: 3000,
          coolSetpointMinCenti: 1600,
          coolSetpointMaxCenti: 3200,
          systemMode: 4,
        },
      },
    });
    expect(digest).toContain('"temperatureCenti":2140');
    expect(digest).toContain('"systemMode":4');
    // The limits stay out — four scalars nobody asks about out loud, and
    // `get_device` is named for exactly them.
    expect(digest).not.toContain('heatSetpointMax');
  });

  /**
   * **An endpoint with nothing to say is left out entirely**, which in a real
   * home is most of the buttons and remotes — and it is what keeps this worth
   * paying for on every spoken turn.
   */
  it('leaves out an endpoint with nothing to report', () => {
    expect(digestOf({ [lightId]: empty })).toBeUndefined();
  });

  /**
   * A full battery is not news, and printing one per line would be the largest
   * thing in the digest about the question nobody asks. Twenty per cent is the
   * device card's own threshold, so the hub and the apps agree about when a
   * battery has become something to say.
   */
  it('mentions a battery only once it is worth mentioning', () => {
    expect(digestOf({ [lightId]: { ...empty, battery: { percent: 84 } } })).toBeUndefined();
    expect(digestOf({ [lightId]: { ...empty, battery: { percent: 12 } } })).toContain(
      '"batteryPercent":12',
    );
  });

  /**
   * Offline is the whole of what there is to say about a device, and it is
   * worth saying: the first message's `online` is as old as the conversation.
   */
  it('says offline and stops there', () => {
    const gone = home();
    gone.devices = gone.devices.map((device) =>
      device.id === lightId ? { ...device, online: false } : device,
    );
    const digest = spokenStateDigest({
      home: gone,
      stateOf: () => ({ ...empty, onOff: true }),
    });
    expect(digest).toContain(`{"id":"${lightId}","online":false}`);
  });

  /** `ep` rides along only where a device has more than one, because almost
   *  none do and it is a field on every line otherwise. */
  it('names an endpoint only on a device that has two', () => {
    const gang = home();
    gang.devices = [
      {
        id: lightId,
        name: 'Two gang',
        roomId: kitchenId,
        online: true,
        endpoints: [
          { endpointId: 1, deviceKind: 'light', capabilities: ['onOff'] },
          { endpointId: 2, deviceKind: 'light', capabilities: ['onOff'] },
        ],
      },
    ];
    const digest = spokenStateDigest({ home: gang, stateOf: () => ({ ...empty, onOff: false }) });
    expect(digest).toContain('"ep":1');
    expect(digest).toContain('"ep":2');

    expect(digestOf({ [lightId]: { ...empty, onOff: false } })).not.toContain('"ep"');
  });

  /** A home where nothing is reporting anything gets no section at all, rather
   *  than a heading over an empty list. */
  /**
   * The one bound on this surface that grows with the *house*, and it is paid
   * on every spoken round — so it has a ceiling, and a cut list says so rather
   * than letting the sentence above it claim the missing devices are reporting
   * nothing.
   */
  it('has a ceiling, and says what it had to leave out', () => {
    const many = Array.from({ length: 200 }, () => randomUUID());
    const digest = spokenStateDigest({
      home: {
        rooms: [],
        zones: [],
        automations: [],
        devices: many.map((id) => ({
          id,
          name: 'Plug',
          roomId: null,
          online: true,
          endpoints: [{ endpointId: 1, deviceKind: 'outlet' as const, capabilities: ['onOff'] }],
        })),
      },
      stateOf: () => ({ ...empty, onOff: true }),
    })!;

    const listed = many.filter((id) => digest.includes(id));
    expect(listed.length).toBeLessThan(many.length);
    expect(digest).toContain(`${many.length - listed.length} more devices`);
    expect(digest).toContain('call get_device rather than saying it is reporting nothing');
  });

  it('says nothing about a list it did not have to cut', () => {
    const digest = digestOf({ [lightId]: { ...empty, onOff: true } })!;
    expect(digest).not.toContain('too long to send whole');
  });

  it('is nothing at all for a home with no readings', () => {
    expect(spokenStateDigest({ home: home(), stateOf: () => undefined })).toBeUndefined();
  });
});
