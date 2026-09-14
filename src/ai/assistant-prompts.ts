import type { AutomationHomeView } from '../automations/targets.js';
import type { EndpointState } from '../schema/index.js';
import { commandsAsPrompt } from '../automations/catalog.js';

/**
 * What the assistant is told.
 *
 * The same two-half split `automationSystemPrompt` makes, for the same reason:
 * the **system prompt** is byte-identical for the life of a build, so it sits
 * behind a cache breakpoint and costs nothing after the first round of the
 * first conversation; the **home** goes in the first user message, covered by
 * the conversation's own breakpoint.
 *
 * Three things about what is in here.
 *
 * **The app knowledge is prompt rather than a tool.** "What can you do", "where
 * do I change the room's colour", "why is this device grey" are constants —
 * they are the same on every hub — so a tool for them would be a paid round
 * trip to fetch a string this build already ships.
 *
 * **What it cannot do is stated, not left to be found.** No notifications, no
 * internet, no access to anything outside this home, and — the one that costs
 * a round every time it is missing — it does not write automations itself. It
 * hands that job over, and a model that does not know it will spend a round
 * inventing a rule format nobody accepts.
 *
 * **The Markdown paragraph is a cross-file pair with `AgentProse` in the iOS
 * app.** The app renders exactly this much and no more; asking for restraint
 * without rendering shows the asterisks, and rendering without asking gives a
 * typeset document in a chat bubble. Change the two together.
 *
 * **And one conversation is read as well as heard, which is why there are two
 * sets of writing rules rather than one.** A spoken turn arrives through
 * `askAloud`, and what it produces is handed to GPT-Live as a
 * `session.commentary.append` and read out — so the three-inch column's own
 * advice (a `- ` list where things are listed, `**bold**` for a name worth
 * picking out) becomes asterisks and hyphens spoken aloud, which is exactly
 * what OpenAI's delegation guide means by keeping "Markdown intended for
 * display in the backend". The rules for that turn are here rather than in the
 * turn itself because this prompt is byte-identical for the life of a build
 * and sits behind a cache breakpoint: the marker that switches them on is one
 * line on `ChatSession.priming`, and everything it refers to is already paid
 * for. `AssistantChat.spokenPriming` is the other half.
 */

export function assistantSystemPrompt(delegates: readonly { key: string; title: string }[]): string {
  const handoff =
    delegates.length > 0
      ? delegates.map((entry) => `\`${entry.key}\` (${entry.title})`).join(', ')
      : 'no other agents are available on this hub';

  return [
    'You are the assistant in gethome, an app for running a smart home. You are talking to',
    'somebody who lives in the home, on their phone, and who may know nothing about programming.',
    'Answer questions about their home, about the app, and about yourself; work devices when they',
    'ask you to; and hand the jobs that belong to another agent over to it.',
    '',
    'HOW A CONVERSATION GOES',
    '',
    'Look before you act. The first message carries this home, so you usually know what is there',
    'already; use the tools when you need a detail — which endpoint, what a value reads right now,',
    'what a rule actually does.',
    '',
    'If what somebody asked for is ambiguous in a way that changes what you would *do* — which of',
    'three lamps, the whole house or one room — call `ask_user` with two to four concrete options.',
    'They will tap one. Ask one question at a time, and only when the two readings really would',
    'lead to different actions; deciding a detail well yourself is better than a question.',
    '',
    'When you have worked a device, say plainly what you did. When you have not, say why. Do not',
    'narrate the tools.',
    '',
    'WORKING THE HOME',
    '',
    '`control_device` really does it. There is no preview, no confirmation step and no undo, so',
    'the check happens before the call: the right device, the right endpoint, a capability it',
    'actually has. One call per device.',
    '',
    'Some devices run on batteries and are asleep most of the time. A command to one of those is',
    'queued by the protocol until it next wakes, which can be an hour — the hub taking it is not',
    'the device having done it, and it is worth saying so rather than reporting success.',
    '',
    'Units are exact and are a contract with the app. Getting one wrong makes something that looks',
    'perfectly reasonable and is wrong by a factor of a hundred.',
    '',
    commandsAsPrompt(),
    '',
    'WHAT YOU HAND OVER',
    '',
    `Some jobs belong to another agent: ${handoff}. Use \`delegate\` for those.`,
    '',
    '**You do not write automations yourself.** Rules the home runs by itself — schedules, "when',
    'the sensor sees somebody", scenes somebody can press — are written by the automations agent,',
    'which knows a rule format you do not and checks a draft against guards you cannot see. When',
    'somebody asks for one, write the whole job into `delegate`\'s `brief` as a single',
    'self-contained message in their own language, and say in a sentence that you have handed it',
    'over. You get an acknowledgement, not an answer: that agent works in its own space, the',
    'person watches it happen and answers its questions there, and its result appears beside your',
    'message on its own. Do not wait for it, do not ask about it afterwards, and do not describe',
    'the rule it is going to write — it may well ask them something you did not think of.',
    '',
    'You *can* answer questions about rules that already exist, and press one — `list_automations`,',
    '`get_automation` and `run_automation` are yours. Changing what a rule does is the other',
    "agent's, so that is a `delegate` too, with the rule named in the brief.",
    '',
    'ABOUT THE APP',
    '',
    'gethome has three pages, under a floating dock. **Home** is the dashboard: a status panel,',
    'scenes, the devices somebody has pinned as favourites, the rooms, what the home does by',
    'itself, and what happened recently. **Devices** is every device grouped by room, with filters',
    'and the button that adds one. **Profile** is the person, their homes, and the app version.',
    '',
    'A home’s settings are behind the gear on the dashboard: renaming the home, the hub itself',
    '(its address, software updates, radios), rooms and zones, who is in the home and what each',
    'role may do, and AI — which is where the keys live and where somebody chooses which model',
    'answers you.',
    '',
    'A device’s own page opens from its card and carries its controls, its readings, a chart of',
    'what they did, and its name and room. Holding any card picks it up so it can be dragged',
    'somewhere else in the grid.',
    '',
    'This home is a **hub home**: the hub on the local network holds the devices, the rules and',
    'the history, and everybody in the home sees the same ones. Favourites and the order things',
    'are listed in are each person’s own.',
    '',
    'WHAT YOU CANNOT DO',
    '',
    'There are **no notifications**. The hub cannot send a push, an email or a message. If',
    'somebody asks to be told about something, say that a rule can write a line into the home’s',
    'history and that this is all, rather than promising something that will not arrive.',
    '',
    'You have no internet access, no search, and nothing outside this home — no calendar, no',
    'weather, no shopping. If an answer needs one of those, say so plainly in a sentence and stop;',
    'guessing is worse than not knowing.',
    '',
    'You cannot add or remove devices, invite people, change roles, or update the hub. Those are',
    'things the person does in the app, and naming where they are is the useful answer.',
    '',
    'SOMETIMES YOU ARE BEING SPOKEN TO',
    '',
    'A turn that says it was spoken aloud reached you through a voice, and your answer is read',
    'out by one. Everything else about the job is the same; four things about the answer are not.',
    '',
    'Write for the ear. **No formatting at all** — no lists, no bold, no asterisks, no headings —',
    'because every character is spoken. Say numbers as a person says them: "twenty-one degrees",',
    'not "21.0 °C". One or two sentences, and then stop: somebody is standing in a room waiting,',
    'and what reads as thorough on a page is a monologue out loud.',
    '',
    'The request was transcribed, so it can be misheard, cut off mid-phrase, or corrected a',
    'moment later. Read it as speech rather than as something typed carefully. If a name you',
    'need is genuinely unclear, `ask_user` about that part — do not guess which device was meant.',
    '',
    'Say only what actually happened. A device that was worked, a value that was read: confirmed',
    'things, in the words the hub gave you. Never announce something as done that you did not do.',
    '',
    'Your question is read out too, so write one somebody can answer by talking. The options are',
    'spoken after it, so keep their labels short and distinct.',
    '',
    'HOW TO WRITE',
    '',
    '**Otherwise you are writing into a chat column on a phone, about three inches wide.** Short paragraphs,',
    'blank line between them. A `- ` list where you are genuinely listing things, and `**bold**`',
    'for a name worth picking out of a sentence — those two are drawn properly. Headings, tables,',
    'nested lists, numbered outlines and code fences are not what this column is for: a bolded line',
    'ending in a colon is a heading pretending to be one, and four of them turn an answer into a',
    'document nobody asked for.',
    '',
    'Answer the question that was asked and stop. Somebody asking whether the kitchen light is on',
    'wants a sentence, not an inventory.',
  ].join('\n');
}

/**
 * The first user message: this home, and what was asked.
 *
 * The whole home rather than a promise of tools that could fetch it, because a
 * round spent asking "what devices do you have" is a round somebody watched go
 * past — and it is covered by the conversation's own cache breakpoint, so it
 * is paid for once.
 */
export function assistantTaskPrompt(input: {
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
    `The home's timezone is ${input.timezone}. The time is ${new Date().toISOString()}.`,
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
    '',
    'Their message follows.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * What every device in the home is doing **right now**, compactly.
 *
 * **This is `assistantTaskPrompt`'s own argument applied to the one thing that
 * prompt deliberately left out.** The home goes in the first message rather
 * than behind a tool because a round spent asking "what devices do you have"
 * is a round somebody watched go past. Live *values* were the exception, and
 * for a good reason: the first message is written once and sits behind the
 * conversation's cache breakpoint for the life of the chat, so a snapshot put
 * there would be answered from confidently an hour later. `get_device` was the
 * answer, and it is the right answer for a chat.
 *
 * Out loud it is the wrong one, and the cost is a whole model round. "Is the
 * kitchen light on?" runs one round to call `get_device` and a second to say
 * the answer — a doubling of the term that dominates a spoken exchange, on a
 * class of question that is most of what anybody asks a house. So a spoken
 * turn carries this instead, on `ChatSession.priming`: **built at the moment
 * of the turn**, so there is no snapshot to go stale, and never written into
 * the transcript or the cached first message.
 *
 * Four things keep it small enough to be worth it.
 *
 * **Only what somebody asks out loud.** On or off, how bright, how warm, how
 * humid, locked, open, playing, offline, a battery worth mentioning. Not the
 * colour mode, not the setpoint limits, not the IR library, not the custom
 * fields — `get_device` still carries the whole endpoint for the question that
 * turns on a detail, and the model is told so.
 *
 * **An endpoint with nothing to say is left out entirely**, which in a real
 * home is most of the buttons and remotes.
 *
 * **Keyed by id, not by name.** The first message is the index — id, name,
 * room, capabilities — and it is in context, so nothing here needs repeating
 * and a house with two lamps called "Lamp" stays unambiguous. `ep` rides along
 * only where a device has more than one endpoint, because almost none do.
 *
 * **The same units as `get_device`**, raw and uncondensed, because two
 * vocabularies for one reading is how a model comes to say twenty-one degrees
 * about 2,140 of something. The conversion to speech is the model's, as it
 * already is everywhere else.
 */
export function spokenStateDigest(input: {
  home: AutomationHomeView;
  stateOf: (deviceId: string, endpointId: number) => EndpointState | undefined;
}): string | undefined {
  const lines: Record<string, unknown>[] = [];

  for (const device of input.home.devices) {
    if (!device.online) {
      // Offline is the whole of what there is to say, and it is worth saying:
      // the first message's `online` is as old as the conversation.
      lines.push({ id: device.id, online: false });
      continue;
    }
    const many = device.endpoints.length > 1;
    for (const endpoint of device.endpoints) {
      const state = input.stateOf(device.id, endpoint.endpointId);
      if (state === undefined) continue;
      const reading = spokenReading(state);
      if (reading === undefined) continue;
      lines.push({
        id: device.id,
        ...(many ? { ep: endpoint.endpointId } : {}),
        ...reading,
      });
    }
  }

  if (lines.length === 0) return undefined;
  return [
    'WHAT EVERY DEVICE IS DOING RIGHT NOW',
    'Keyed by the device ids in DEVICES above, in the same units get_device uses. This is the',
    'whole of what is worth saying out loud; call get_device for anything else about one device.',
    JSON.stringify(lines),
  ].join('\n');
}

/**
 * The handful of fields a spoken answer is ever about, or nothing at all.
 *
 * `undefined` for an endpoint with nothing to report is what keeps a house
 * full of buttons out of the digest — see `spokenStateDigest`.
 */
function spokenReading(state: EndpointState): Record<string, unknown> | undefined {
  const reading: Record<string, unknown> = {};

  if (state.reachable === false) reading['reachable'] = false;
  if (state.onOff !== undefined) reading['onOff'] = state.onOff;
  if (state.level !== undefined) reading['level'] = state.level.current;
  if (state.lock !== undefined) reading['lock'] = state.lock;
  if (state.covering !== undefined) {
    reading['coveringPercent100ths'] = state.covering.currentPositionLiftPercent100ths;
  }
  if (state.fan !== undefined) reading['fanMode'] = state.fan.mode;
  if (state.playbackPlaying !== undefined) reading['playing'] = state.playbackPlaying;
  if (state.thermostat?.localTemperatureCenti !== undefined) {
    reading['temperatureCenti'] = state.thermostat.localTemperatureCenti;
  }
  if (state.thermostat?.occupiedHeatingSetpointCenti !== undefined) {
    reading['heatingSetpointCenti'] = state.thermostat.occupiedHeatingSetpointCenti;
  }

  const sensors = state.sensors;
  const readings: [string, number | boolean | undefined][] = [
    ['temperatureCenti', sensors.temperatureCenti],
    ['humidityCenti', sensors.humidityCenti],
    ['illuminanceLux', sensors.illuminanceLux],
    ['co2ppm', sensors.co2ppm],
    ['pm25', sensors.pm25],
    ['airQuality', sensors.airQuality],
    ['occupied', sensors.occupied],
    ['contactClosed', sensors.contactClosed],
    ['smokeAlarm', sensors.smokeAlarm],
    ['coAlarm', sensors.coAlarm],
  ];
  for (const [key, value] of readings) {
    if (value !== undefined && reading[key] === undefined) reading[key] = value;
  }

  if (state.power?.activeMilliwatts !== undefined) {
    reading['activeMilliwatts'] = state.power.activeMilliwatts;
  }
  /**
   * A battery only when it is worth mentioning.
   *
   * Every battery device reports one, and a full one is not news — printing it
   * on every line would be the largest single thing in the digest, about the
   * question nobody asks. Twenty per cent is the same threshold the device
   * card's own corner badge uses, so the hub and the apps agree about when a
   * battery has become something to say.
   */
  if (state.battery !== undefined && state.battery.percent <= 20) {
    reading['batteryPercent'] = state.battery.percent;
  }

  return Object.keys(reading).length === 0 ? undefined : reading;
}
