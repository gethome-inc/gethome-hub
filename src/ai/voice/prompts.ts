import type { AutomationHomeView } from '../../automations/targets.js';
import { automationShape } from '../../automations/summarize.js';
import type { ChatMessageWire } from '../chat/chat-runtime.js';
import {
  LIVE_HISTORY_CHARS,
  LIVE_HISTORY_MESSAGE_CHARS,
  LIVE_HISTORY_MESSAGES,
  type LiveHistoryMessage,
} from './live-wire.js';

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
 * Names and nothing else, deliberately — rooms, devices, and the scenes
 * somebody could ask for by name. Under client delegation the voice has no
 * tools and cannot touch a device, so a device id, a capability list or an
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
 * **What comes back is spoken, and the fix for that is at the other end.** For
 * a while this asked the voice to relay the backend's answer word for word and
 * not to restate it — which is a rule the API will not keep: `commentary` is
 * documented as content "the model is trained to paraphrase", so the
 * instruction was fighting the model's own training for something it never
 * promised. Worse, it was fighting it on *behalf* of the wrong text: the
 * backend was writing for a three-inch phone column, bold and bullets
 * included, exactly what OpenAI's delegation guide means by keeping "Markdown
 * intended for display in the backend".
 *
 * So the backend is told when it is being spoken to and writes for the ear
 * (`assistantSystemPrompt`'s *SOMETIMES YOU ARE BEING SPOKEN TO*), and what is
 * left here is the half that matters and that the model *can* keep: every fact
 * and every number survives, nothing is added, and a caveat is not dropped for
 * being inconvenient. The page and the room no longer have to be the same
 * sentence — the app already draws both, the hub's row and the caption of what
 * was actually said.
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
  /**
   * The rules somebody could *press*, by name.
   *
   * Same argument as the devices: the voice cannot run one, but it has to hear
   * "put Movie Night on" as a name rather than as three words, and say it back
   * the way the home spells it. Only the pressable ones — a `watching` rule is
   * something the house does by itself and nobody asks for it out loud — and
   * the enabled ones, since a switched-off rule is not a thing to offer.
   * Bounded with the devices, because a home with eighty scenes is the same
   * context problem by another door.
   */
  const scenes = home.automations
    .filter((rule) => rule.enabled && automationShape(rule.document) !== 'watching')
    .slice(0, NAME_LIMIT)
    .map((rule) => rule.name);

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
    '- A still-current result the backend gave you already answers the question.',
    '- You cannot tell what they are asking for without a brief clarification.',
    '',
    'The names at the end of these instructions are so you can hear them and say them back',
    'correctly. They are a snapshot taken when this conversation opened, they are not the whole',
    'home, and they say nothing about what anything is doing. Never answer from them: what the',
    'home has, what it is doing, and what a scene or rule does are the backend’s answers, every',
    'time, even when a name is right there in front of you.',
    '',
    'Delegate before giving an answer that depends on backend work. Do not guess the result while',
    'waiting, and never say a thing is done before the backend reports that it is — say what you',
    'are doing in a few words, keep listening, and then say what came back. If the backend says',
    'something could not be done, say so plainly and say why.',
    '',
    'What the backend sends back is already written to be spoken. Say it. Keep every fact and',
    'every number in it, add nothing it did not say, and do not leave out a caveat because it is',
    'inconvenient — it is the only thing in this conversation that knows what actually happened.',
    '',
    'Adding devices, inviting people, changing what anybody is allowed to do and updating the hub',
    'are things a person does in the app, and nothing on either side of this conversation can do',
    'them. Say so plainly — and if they ask where, delegate, because the backend knows the app',
    'and you do not.',
    '',
    `The timezone is ${input.timezone}.`,
    input.personName !== undefined ? `You are talking to ${input.personName}.` : '',
    '',
    'SOME ROOMS, BY NAME',
    rooms.join(', '),
    '',
    'SOME DEVICES, BY NAME',
    devices.join(', '),
    ...(scenes.length > 0
      ? ['', 'SOME SCENES AND MODES THEY CAN ASK FOR, BY NAME', scenes.join(', ')]
      : []),
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
 * interaction and reads as nonsense out loud. **Bounded twice** — the last few
 * messages, *and* a budget in characters, because the API caps this list at
 * both 128 messages and 8,192 tokens and only the first of those is a count
 * anything here could keep by itself (`LIVE_HISTORY_CHARS` has the arithmetic,
 * and why a row of 4,000 characters made a dozen of them a refusal rather than
 * a long prompt). And **roles carry their own content type**: `input_text` for
 * what the person said, `output_text` for what the assistant said, which is
 * the API's own asymmetry rather than ours.
 *
 * The budget is spent newest-first and the list is put back in order at the
 * end, so what a session opens knowing is the exchange somebody is about to
 * refer to rather than whatever happened to be oldest.
 */
export function liveHistory(rows: ChatMessageWire[]): LiveHistoryMessage[] {
  const spoken = rows
    .filter((row) => row.role === 'user' || row.role === 'agent')
    .slice(-LIVE_HISTORY_MESSAGES);

  const kept: LiveHistoryMessage[] = [];
  let budget = LIVE_HISTORY_CHARS;
  for (let index = spoken.length - 1; index >= 0; index -= 1) {
    const row = spoken[index];
    if (row === undefined) continue;
    // Clipped before it is measured, so one long answer costs what it is
    // allowed to cost rather than the whole budget.
    const text = row.text.slice(0, LIVE_HISTORY_MESSAGE_CHARS);
    if (text.length > budget) break;
    budget -= text.length;
    kept.push(
      row.role === 'user'
        ? {
            type: 'message' as const,
            role: 'user' as const,
            content: [{ type: 'input_text' as const, text }] as [
              { type: 'input_text'; text: string },
            ],
          }
        : {
            type: 'message' as const,
            role: 'assistant' as const,
            content: [{ type: 'output_text' as const, text }] as [
              { type: 'output_text'; text: string },
            ],
          },
    );
  }
  return kept.reverse();
}
