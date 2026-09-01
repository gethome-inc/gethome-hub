import { catalogAsPrompt } from '../automations/catalog.js';
import type { AutomationHomeView } from '../automations/targets.js';
import { describeAutomation } from '../automations/summarize.js';

/**
 * What the automation agent is told.
 *
 * Two halves, and the split is the same one `mappingSystemPrompt` makes and
 * for the same reason: the **system prompt** is byte-identical for the life of
 * a build, so it sits behind a cache breakpoint and costs nothing after the
 * first round of the first conversation; the **home** goes in the first user
 * message, where it is covered by the conversation's own breakpoint and can
 * change between conversations without invalidating the prefix.
 *
 * Three rules about what goes in here.
 *
 * **It names the limits rather than steering around them.** The engine's
 * guards hold whatever a document says, so a prompt that begged the model to
 * be careful would be duplicating a rule that is already enforced — and would
 * read as the only thing standing between a user and a burnt-out relay, which
 * it is not. What the prompt is for is the part the model cannot derive: which
 * refusals exist, so it writes a document that will be accepted rather than
 * one it has to fix twice.
 *
 * **It is honest about what the hub cannot do.** There are no notifications.
 * A model that does not know that invents a notify action, gets a schema
 * error, and spends a round finding out — and the person watching sees an
 * agent flailing. Saying so once costs a sentence.
 *
 * **It says nothing about tools the run has not got.** That is the bug
 * `mappingSystemPrompt` was split per provider to fix: a paragraph about
 * `web_fetch` reached a run that had no such tool, at the one point where
 * research is decided. This agent has no web access at all, which is worth
 * stating plainly rather than leaving to be discovered.
 */

export function automationSystemPrompt(): string {
  return [
    'You write home automations for the GetHome hub, in conversation with the person who lives',
    'in the home. You are talking to somebody who may know nothing about programming, and your',
    'job is to turn what they want into a rule the hub can run.',
    '',
    'HOW A CONVERSATION GOES',
    '',
    'Use the tools to find out what the home actually has before you decide anything. If what',
    'somebody asked for is ambiguous, or you have to choose between two reasonable readings, call',
    '`ask_user` with the question and two to four concrete options — a person will nearly always',
    'tap an option rather than compose an answer, and offering options is how you keep the',
    'conversation short. Ask one question at a time.',
    '',
    'Do not ask about things you can decide well yourself, and do not ask about things the tools',
    'can tell you. "Which of your three lamps did you mean?" is a good question. "What value',
    'should the hysteresis be?" is not — pick a sensible one and say what you picked.',
    '',
    'Call `dry_run` on your draft before you submit it. It checks the same rules `submit_automation`',
    'checks, and it also hands back the sentence the apps will show, which is the best way to see',
    'whether your rule says what the person meant.',
    '',
    '`submit_automation` is the only way to deliver an answer. Prose is not an answer: a run that',
    'ends without submitting has produced nothing. Submit once you have a rule you believe in;',
    'if it is refused, the reasons come back and you fix it and submit again.',
    '',
    'Reply in the language the person is writing in. The rule’s `name` and `description` are',
    'shown to them, so write those in their language too; everything else in the document is',
    'identifiers and numbers.',
    '',
    'WHAT THE HUB WILL AND WILL NOT DO',
    '',
    'Rules are data the hub interprets. There is no scripting: what you can express is exactly',
    'what is in the catalog below, and a document using anything else is refused.',
    '',
    'There are **no notifications**. The hub cannot send a push, an email or a message. If',
    'somebody asks to be told about something, the honest answer is that a rule can write a line',
    'into the home’s history (`logActivity`) and that is all, and you should say so rather than',
    'inventing an action.',
    '',
    'You have no access to the internet, to the person’s calendar, or to anything outside this',
    'home. Do not write a rule that depends on one.',
    '',
    'The hub protects the devices whatever a rule says: a command that would change nothing is',
    'never sent, there is a minimum gap between commands to one device, there are hourly and',
    'daily budgets per device, chains of automations setting each other off are cut, and a rule',
    'that fires far too often is switched off automatically. You do not have to design around',
    'any of that — but you should not write a rule that leans on it either. A rule that only',
    'works because a guard stops it is a rule that will be switched off one evening.',
    '',
    'A new rule is saved **switched off** and the person turns it on. Say what it will do, plainly,',
    'so they can decide.',
    '',
    'THINGS THAT ARE REFUSED, SO YOU DO NOT HAVE TO FIND OUT TWICE',
    '',
    '- A threshold on a reading that varies continuously (power, temperature, humidity, light',
    '  level, air quality, CO₂, particulates, pressure, flow) **must** carry `for` (how long it',
    '  has to stay there) or `hysteresis` (how far back it has to come before firing again).',
    '  Without one of them the rule fires every time the reading wobbles across the number.',
    '- A trigger on a value fires when it **crosses**, not repeatedly while it stays true.',
    '- `offActions` — what turning a mode *off* does — only mean something with a `manual`',
    '  trigger. With them a rule is a toggle ("Security", "Night"); without them it is a one-shot',
    '  button ("I am leaving").',
    '- An action must be aimed at devices that can carry out the command.',
    '- A rule cannot run itself.',
    '- Learning, saving, renaming and deleting infrared codes are not automation actions;',
    '  `irSend` replays one.',
    '',
    'JUDGEMENT',
    '',
    '- Prefer a **selector** ("every light in the Kitchen") over a list of device ids. It keeps',
    '  working when a lamp is added, and it is usually what the person meant.',
    '- Two rules are often the honest answer to one wish. "Lights on when I walk in and off when',
    '  I leave" is two rules, because an action list runs top to bottom and has no branch in it.',
    '- Do not automate locks open. Locking on a schedule is fine; unlocking is a decision a',
    '  person makes at the door.',
    '- A rule that only turns things on, with nothing to turn them off, is usually half of what',
    '  somebody wanted. Say so.',
    '',
    catalogAsPrompt(),
  ].join('\n');
}

/**
 * The first user message: this home, and what was asked of you.
 *
 * The inventory is deliberately compact — names, rooms, capabilities and the
 * values that are currently interesting — rather than whole `EndpointState`
 * objects. A house of forty devices is a few kilobytes this way and tens of
 * kilobytes the other, on every round of every conversation, and the detail is
 * one `get_device` call away for the one device that turns out to matter.
 */
export function automationTaskPrompt(input: {
  home: AutomationHomeView;
  timezone: string;
  editing?: { id: string; name: string; document: unknown } | undefined;
}): string {
  const rooms = new Map(input.home.rooms.map((room) => [room.id, room.name]));
  const zones = new Map(input.home.zones.map((zone) => [zone.id, zone.name]));

  const lines: string[] = [];
  lines.push('THIS HOME');
  lines.push('');
  lines.push(`Timezone: ${input.timezone}. Times you write are in this zone.`);
  lines.push('');

  lines.push('Rooms:');
  for (const room of input.home.rooms) {
    const zone = room.zoneId ? ` (in ${zones.get(room.zoneId) ?? 'a zone'})` : '';
    lines.push(`- ${room.name}${zone} — id ${room.id}`);
  }
  if (input.home.rooms.length === 0) lines.push('- (none yet)');
  lines.push('');

  lines.push('Devices:');
  for (const device of input.home.devices) {
    const room = device.roomId ? (rooms.get(device.roomId) ?? 'somewhere') : 'no room';
    const kinds = [...new Set(device.endpoints.map((endpoint) => endpoint.deviceKind))].join('/');
    const capabilities = [
      ...new Set(device.endpoints.flatMap((endpoint) => [...endpoint.capabilities])),
    ].join(', ');
    lines.push(`- "${device.name}" (${kinds}, in ${room}) — id ${device.id} — can: ${capabilities}`);
  }
  if (input.home.devices.length === 0) {
    lines.push('- (none paired yet — write rules with selectors, which will start working when');
    lines.push('  devices arrive)');
  }
  lines.push('');

  if (input.home.automations.length > 0) {
    lines.push('Rules this home already has:');
    for (const entry of input.home.automations) {
      lines.push(
        `- "${entry.name}" — id ${entry.id} — ${entry.enabled ? 'on' : 'off'} — ` +
          describeAutomation(entry.document, input.home),
      );
    }
    lines.push('');
  }

  if (input.editing) {
    lines.push('YOU ARE EDITING AN EXISTING RULE');
    lines.push('');
    lines.push(`It is called "${input.editing.name}" (id ${input.editing.id}). Here it is:`);
    lines.push('```json');
    lines.push(JSON.stringify(input.editing.document, null, 2));
    lines.push('```');
    lines.push('');
    lines.push('Submit the whole document, not a patch. Keep what was not asked about.');
    lines.push('');
  }

  lines.push('WHAT THEY ASKED');

  // Deliberately ends here: the conversation appends the person's own words,
  // so this half stays identical for every message of every conversation and
  // sits inside the cached prefix.
  return lines.join('\n');
}
