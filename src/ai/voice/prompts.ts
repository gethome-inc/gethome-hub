import type { AutomationHomeView } from '../../automations/targets.js';
import { commandsAsPrompt } from '../../automations/catalog.js';

/**
 * What the voice is told, and it is a different job from what the assistant is
 * told.
 *
 * The typed assistant writes into a column three inches wide and is read; this
 * one is *heard*, out loud, by somebody standing in a room who can interrupt.
 * Nearly every rule the written prompt has about shape — bold for a name worth
 * picking out, a list where something is genuinely listed — is meaningless
 * here and actively harmful if the model reaches for it, because a spoken
 * asterisk is a spoken asterisk.
 *
 * **And the whole of the home goes into the instructions rather than into a
 * first message.** A live session has no turns to put a task prompt in front
 * of: the person simply starts talking, and the model has to already know
 * which lamp "the kitchen one" is. The cost is that the home is a snapshot
 * taken when the session opened — a device renamed mid-conversation is the old
 * name until the next one — which is the right trade for a surface measured in
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
 * **And the split is named explicitly rather than left to `ask_home`'s own
 * description.** The failure being designed against is not the model getting
 * something wrong, it is the model being *slow* about something it could have
 * done itself: a light switched through the backend is three seconds where it
 * should have been a third of one, and that difference is the whole feel of the
 * thing.
 */
export function liveInstructions(input: {
  home: AutomationHomeView;
  timezone: string;
  personName?: string | undefined;
}): string {
  const { home } = input;
  const rooms = home.rooms.map((room) => ({ id: room.id, name: room.name, zoneId: room.zoneId }));
  const devices = home.devices.map((device) => ({
    id: device.id,
    name: device.name,
    roomId: device.roomId,
    online: device.online,
    endpoints: device.endpoints.map((endpoint) => ({
      endpointId: endpoint.endpointId,
      kind: endpoint.deviceKind,
      capabilities: endpoint.capabilities,
    })),
  }));

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
    '- Confirm what you did in the fewest words that are still specific: "Kitchen light off."',
    '- If you are about to take a few seconds, say so first — "let me work that out" — and keep',
    '  listening while you do.',
    '- Never read out a device id, a room id or any other identifier. Use the name.',
    '',
    'WHAT YOU DO YOURSELF, IMMEDIATELY',
    'Switching, dimming, colour, blinds, locks, running a scene, and reading what the home is',
    'doing right now. These are your own tools and they happen in a moment. Do them and say so.',
    'If two devices could be meant, ask which — one short question — rather than guessing.',
    '',
    'WHAT YOU HAND OVER',
    'Anything that needs working out, anything about automations or schedules, and anything you',
    'have no tool for. `ask_home` reaches the assistant on this home’s hub, which is a more',
    'capable model with more it can do. Hand over the whole request in the person’s own words.',
    'It takes a few seconds; say what you are doing and carry on listening.',
    '',
    'WHAT YOU CANNOT DO',
    'You cannot add devices, invite people, change what anybody is allowed to do, or update the',
    'hub. Say so plainly and say where it is done — those live in the app.',
    '',
    'UNITS, WHEN YOU WORK A DEVICE',
    commandsAsPrompt(),
    '',
    `THE HOME. The timezone is ${input.timezone}.`,
    input.personName !== undefined ? `You are talking to ${input.personName}.` : '',
    '',
    'ROOMS AND ZONES',
    JSON.stringify({ rooms, zones: home.zones }),
    '',
    'DEVICES',
    JSON.stringify(devices),
    '',
    'RULES THIS HOME ALREADY RUNS',
    JSON.stringify(
      home.automations.map((rule) => ({ id: rule.id, name: rule.name, enabled: rule.enabled })),
    ),
  ]
    .filter((line) => line !== '')
    .join('\n');
}
