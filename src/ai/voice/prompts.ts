import type { AutomationHomeView } from '../../automations/targets.js';
import type { ChatMessageWire } from '../chat/chat-runtime.js';
import { LIVE_HISTORY_MESSAGES, type LiveHistoryMessage } from './live-wire.js';

/**
 * What the voice is told, and it is a **much smaller** job than what the
 * assistant is told.
 *
 * The typed assistant writes into a column three inches wide and is read; this
 * one is *heard*, out loud, by somebody standing in a room who can interrupt.
 * Nearly every rule the written prompt has about shape — bold for a name worth
 * picking out, a list where something is genuinely listed — is meaningless
 * here and actively harmful if the model reaches for it, because a spoken
 * asterisk is a spoken asterisk.
 *
 * **And the split is the migration guide's own advice, which happens to be the
 * architecture this hub already had.** Conversation style and *when to ask for
 * help* go to the voice; business rules, tool workflows and the whole shape of
 * the home go to the backend — and the backend here is the assistant on this
 * hub, whose prompt already carries every one of them. So this file is what is
 * left after that subtraction: how to sound, what to hand over, and enough of
 * the home's **names** to hear "the kitchen one" correctly and say it back.
 *
 * Names and nothing else, deliberately. Under client delegation the voice has
 * no tools and cannot touch a device, so a device id, a capability list or an
 * endpoint number here would be context it can only mispronounce — and the
 * instructions are capped at 16,384 tokens, which a large home's full device
 * JSON was heading for. The cost is that the names are a snapshot taken when
 * the session opened, which is the right trade for a surface measured in
 * minutes.
 */

/**
 * How to speak, and what to hand over.
 *
 * Three things this says that the written prompt does not, each because
 * somebody is *listening*:
 *
 * **Say what you are doing before you go and do it.** Delegation takes seconds
 * and the model can talk during them; silence for three seconds in a spoken
 * conversation reads as a failure, where the same three seconds on a page is a
 * spinner nobody minds.
 *
 * **Never format anything.** A model writing for a page reaches for a list the
 * moment there are three of something, and the list is read out as prose with
 * the bullets in it.
 *
 * **And it must not claim to have done things.** This is the one rule that got
 * *stronger* when the fast tools went away: the voice has no tools at all now,
 * so "kitchen light off" spoken before the hub has answered is a sentence about
 * something that has not happened. Announce what the backend reports, not what
 * was asked for — the appointment example in OpenAI's own migration guide is
 * the same rule about a booking.
 */
export function liveInstructions(input: {
  home: AutomationHomeView;
  timezone: string;
  personName?: string | undefined;
}): string {
  const { home } = input;
  const rooms = home.rooms.map((room) => room.name);
  const byRoom = new Map(home.rooms.map((room) => [room.id, room.name]));
  const devices = home.devices.map((device) => {
    const room = device.roomId === null ? undefined : byRoom.get(device.roomId);
    return room === undefined ? device.name : `${device.name} (${room})`;
  });

  return [
    'You are the voice of gethome, talking to somebody in their own home. You can hear them and',
    'speak at the same time, so they can interrupt you at any point — when they do, stop and',
    'listen.',
    '',
    'HOW YOU SOUND',
    '- Short sentences. One or two, then stop. This is a conversation, not a paragraph.',
    '- Never format anything. No lists, no headings, no bold, no asterisks — every character you',
    '  produce is spoken aloud.',
    '- Say numbers the way a person says them: "twenty-one degrees", not "21.0 °C".',
    '- Use the home’s own names for rooms and devices, and never read out an identifier.',
    '',
    'HOW THE WORK HAPPENS',
    'You do not work the home yourself. Everything — switching a light, reading a temperature,',
    'anything about schedules or rules, anything that needs working out — is handed to the',
    'assistant on this home’s hub, which has every tool and knows the whole house. Hand over',
    'anything the person asks for, in their own words.',
    '- Say what you are doing first, in a few words — "one moment" — and keep listening while the',
    '  answer comes back. It usually takes a second or two.',
    '- Then say what came back. Never announce a thing as done before the hub reports that it is:',
    '  "kitchen light off" said ahead of the answer is a sentence about something that has not',
    '  happened yet.',
    '- If two devices could be meant, ask which — one short question — rather than guessing.',
    '- If the answer says something could not be done, say so plainly and say why.',
    '',
    'WHAT NOBODY CAN DO FROM HERE',
    'Adding devices, inviting people, changing what anybody is allowed to do, and updating the',
    'hub all live in the app. Say so plainly rather than handing them over.',
    '',
    `THE HOME. The timezone is ${input.timezone}.`,
    input.personName !== undefined ? `You are talking to ${input.personName}.` : '',
    '',
    'ROOMS',
    rooms.join(', '),
    '',
    'DEVICES, BY NAME',
    devices.join(', '),
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * What the session opens knowing, out of the conversation it is continuing.
 *
 * **This is what makes pressing the microphone on a page you have been typing
 * on feel like one conversation** rather than two. A live session has no turns
 * to put a task prompt in front of — the person simply starts talking — so
 * prior exchanges go in `session.input`, which the API reads before the first
 * word.
 *
 * Three rules. **Only what was actually said**: `user` and the agent's own
 * answers, where a `question`, a `preview` or a `handoff` row is a page's
 * interaction and reads as nonsense out loud. **Bounded** — the last few
 * messages, not the fortnight the transcript keeps, because a voice session
 * pays for context nobody is about to refer to. And **roles carry their own
 * content type**: `input_text` for what the person said, `output_text` for
 * what the assistant said, which is the API's own asymmetry rather than ours.
 */
export function liveHistory(rows: ChatMessageWire[]): LiveHistoryMessage[] {
  const spoken = rows.filter((row) => row.role === 'user' || row.role === 'agent');
  return spoken.slice(-LIVE_HISTORY_MESSAGES).map((row) =>
    row.role === 'user'
      ? {
          type: 'message' as const,
          role: 'user' as const,
          content: [{ type: 'input_text' as const, text: row.text }] as [
            { type: 'input_text'; text: string },
          ],
        }
      : {
          type: 'message' as const,
          role: 'assistant' as const,
          content: [{ type: 'output_text' as const, text: row.text }] as [
            { type: 'output_text'; text: string },
          ],
        },
  );
}
