import type { AutomationHomeView } from '../../automations/targets.js';
import type { ChatMessageWire } from '../chat/chat-runtime.js';
import { LIVE_HISTORY_MESSAGES, type LiveHistoryMessage } from './live-wire.js';

/**
 * How many device names the voice is given.
 *
 * The live model's context window is **small** — the prompting guide says so in
 * as many words — so this is a bound rather than a formality. It is generous
 * for an ordinary home and stops a warehouse of eighty smart plugs from
 * crowding out the policy above it; what is trimmed is trimmed silently,
 * because the voice cannot act on a device anyway and a sentence apologising
 * for an incomplete list would cost more context than the names did.
 */
const NAME_LIMIT = 80;

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
 * **The shape is the prompting guide's own**, labels included, and that is
 * deliberate: `Backchannel policy`, `Interruption policy` and a
 * `Delegation policy` split into *Backend tools*, *Delegate when* and *Do not
 * delegate when*. The guide asks for those labels by name and for concrete
 * conditions rather than "delegate when needed", so this reads as a policy a
 * person could check against a handful of real requests — which is how it
 * should be revised when the voice turns out to delegate too much or too
 * little.
 *
 * Four things this says that the written prompt does not, each because somebody
 * is *listening*:
 *
 * **Say what you are doing before you go and do it.** Delegation takes a second
 * or two and the model can talk during them; silence for three seconds in a
 * spoken conversation reads as a failure, where the same three seconds on a
 * page is a spinner nobody minds.
 *
 * **Never format anything.** A model writing for a page reaches for a list the
 * moment there are three of something, and the list is read out as prose with
 * the bullets in it.
 *
 * **A room is a noisy place.** The guide's optional control for silence and
 * background noise is not optional here: a kitchen has a television in it,
 * other people talking, and a kettle, and a voice that treats every sound as a
 * request is one somebody switches off. Its sibling — ask about the part you
 * did not catch — earns its place for the same reason, since the thing most
 * often misheard in this app is a room or device name.
 *
 * **And what comes back is said as it was written.** The page and the room are
 * the same conversation: the answer the backend produced is the row an app
 * draws, and the voice saying a re-worded version of it leaves somebody
 * reading one sentence while hearing another — which is the one thing a
 * transcript is for. It is also where a re-wording quietly loses a number or a
 * caveat the agent was careful about. So the instruction is to relay rather
 * than to retell, with the one exception a room genuinely needs: a list read
 * out with its bullets in it is the next paragraph's problem.
 *
 * **And it must not claim to have done things.** This is the rule that got
 * *stronger* when the fast tools went away: the voice has no tools at all now,
 * so "kitchen light off" spoken before the hub has answered is a sentence about
 * something that has not happened. Announce what the backend reports, not what
 * was asked for.
 *
 * What is deliberately **not** here is everything the guide says to keep in the
 * backend: the procedures, the units, the capability model, the device ids. The
 * backend is the assistant on this hub, whose own prompt carries all of it.
 */
export function liveInstructions(input: {
  home: AutomationHomeView;
  timezone: string;
  personName?: string | undefined;
}): string {
  const { home } = input;
  const rooms = home.rooms.map((room) => room.name);
  const byRoom = new Map(home.rooms.map((room) => [room.id, room.name]));
  const devices = home.devices.slice(0, NAME_LIMIT).map((device) => {
    const room = device.roomId === null ? undefined : byRoom.get(device.roomId);
    return room === undefined ? device.name : `${device.name} (${room})`;
  });

  return [
    'You are the voice of gethome, a calm, friendly assistant talking to somebody in their own',
    'home. Speak warmly and naturally, at an unhurried pace. One or two short sentences, then',
    'stop. Be clear and direct, not overly cheerful. If they are frustrated, acknowledge it',
    'briefly and focus on the next helpful step.',
    '',
    'Never format anything. No lists, no headings, no bold, no asterisks — every character you',
    'produce is spoken aloud. Say numbers the way a person says them: "twenty-one degrees", not',
    '"21.0 °C". Use the home’s own names for rooms and devices, and never read out an identifier.',
    '',
    'Backchannel policy: Use moderate backchannels. Acknowledge naturally without competing with',
    'the main response.',
    '',
    'Interruption policy: Stop speaking when the user interrupts. Listen to what they say.',
    '',
    'Keep listening while they pause to think. Do not treat a television, music or a nearby',
    'conversation as a new request. If a room or device name is unclear, ask about that part',
    'rather than guessing which one they meant.',
    '',
    'Delegation policy:',
    'Backend tools:',
    '- Devices: switch things on and off, dim, set colour, open and close blinds, set a',
    '  thermostat, and read what any device is doing right now.',
    '- The home: what is on, what is offline, temperatures, power, who did what recently.',
    '- Scenes and automations: run one, and write, change or explain the rules the home runs by',
    '  itself.',
    '- The app: answer questions about gethome itself.',
    '',
    'Delegate to the backend when:',
    '- They ask you to do anything to the home, however small.',
    '- They ask what the home is doing, or about a device, a room, a scene or a rule.',
    '- A correction changes work already requested.',
    '- The answer needs careful reasoning.',
    '',
    'Do not delegate to the backend when:',
    '- They greet you, or ask you to repeat something you have already said.',
    '- A still-current result already answers the question.',
    '- You cannot tell what they are asking for without a brief clarification.',
    '',
    'Delegate before giving an answer that depends on backend work. Do not guess the result while',
    'waiting, and never say a thing is done before the backend reports that it is — say what you',
    'are doing in a few words, keep listening, and then say what came back. If the backend says',
    'something could not be done, say so plainly and say why.',
    '',
    'Say the backend’s answer as it was given. Keep its wording and every fact in it, and add',
    'nothing it did not say. Change only what would not read aloud: unfold a list into a sentence,',
    'say a symbol as a word. Do not summarise it, and do not restate it in your own words.',
    '',
    'Adding devices, inviting people, changing what anybody is allowed to do and updating the hub',
    'all live in the app. Say so plainly rather than delegating them.',
    '',
    `The timezone is ${input.timezone}.`,
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
