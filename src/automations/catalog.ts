import { z } from 'zod';
import { CAPABILITY_KINDS, DEVICE_KINDS, type CapabilityKind } from '../schema/index.js';
import {
  AUTOMATION_MODES,
  MAX_ACTIONS,
  MAX_CONDITION_DEPTH,
  MAX_FAN_OUT,
  MAX_WAIT_MS,
  MIN_HOLD_MS,
  MIN_INTERVAL_MS,
  READABLE_PATHS,
  READABLE_PATH_KEYS,
  automationDocumentSchema,
  commandCapability,
  isContinuousPath,
  type ReadablePath,
} from './schema.js';

/**
 * What an automation can be made of — generated, never written by hand.
 *
 * This is the page the product promises ("somewhere you can see the available
 * functions, and the list will keep growing"), and it is the same document
 * the agent receives as its reference. Generating it from the live zod schema
 * is the whole point: a catalog typed out by a person drifts from what the
 * validator accepts, and it drifts **silently** — the rule that put
 * `GET /permissions` on the wire rather than shipping a copy of the
 * permission list in each app, applied to a vocabulary that will keep moving
 * as protocols and capabilities are added.
 *
 * So there is one source and three consumers: the agent (as a tool result),
 * the apps (as a screen), and `docs/automations.md` (as prose generated from
 * the same call). Adding a trigger kind means editing `schema.ts` and adding
 * one line of description here; nothing else has to be told.
 *
 * **Units are the part that has to be right.** The hub's canonical units are
 * a compatibility contract with the apps — level is 1–254, temperatures are
 * centi-degrees, a covering's 0 is *open* — and a model that writes 22 for
 * 22 °C produces a rule that is wrong by two orders of magnitude and looks
 * perfectly reasonable. Every path and every command below carries its unit
 * in words for exactly that reason.
 */

export interface CatalogEntry {
  /** The `kind` (or `type`) as it appears in a document. */
  id: string;
  /** One sentence a person can read. */
  summary: string;
  /** What to watch out for, when there is something. */
  note?: string;
}

export interface CatalogPath extends CatalogEntry {
  type: 'number' | 'boolean';
  /** Written out, because this is where a factor-of-100 mistake lives. */
  unit?: string;
  /**
   * True when the reading moves on its own, continuously. A threshold on one
   * of these needs `for` or `hysteresis` — see `sanity.ts`.
   */
  continuous: boolean;
}

export interface CatalogCommand extends CatalogEntry {
  /** The capability a target must have for this command to land. */
  capability: CapabilityKind | null;
}

export interface AutomationCatalog {
  /** The document version this build writes and understands. */
  version: number;
  /** JSON Schema for the whole document, generated from the zod schema. */
  schema: Record<string, unknown>;
  bounds: {
    minIntervalMs: number;
    maxWaitMs: number;
    maxActions: number;
    maxFanOut: number;
    minHoldMs: number;
    maxConditionDepth: number;
  };
  modes: readonly string[];
  triggers: CatalogEntry[];
  conditions: CatalogEntry[];
  actions: CatalogEntry[];
  paths: CatalogPath[];
  commands: CatalogCommand[];
  capabilities: readonly CapabilityKind[];
  deviceKinds: readonly string[];
}

// ── Descriptions ─────────────────────────────────────────────────────────────
//
// The only hand-written half, and deliberately the *smallest* one: a sentence
// per node kind. Everything structural — which fields exist, what they accept,
// what the bounds are — comes out of the schema.

const TRIGGERS: CatalogEntry[] = [
  {
    id: 'deviceState',
    summary: 'A reading crossed a line, or a value moved.',
    note:
      'It fires on the CROSSING, not on every report while the test still holds — a battery at ' +
      '12% fires once, not every hour. On a reading that varies continuously (power, temperature, ' +
      'humidity, light level, air quality) a bare threshold is refused anyway: give it "for" (how ' +
      'long it must stay there) or "hysteresis" (how far back it must come before it can fire again).',
  },
  {
    id: 'deviceEvent',
    summary: 'A button was pressed on a remote, a wall switch or a cube.',
    note: 'Leave "button" or "gesture" out to match any of them.',
  },
  {
    id: 'schedule',
    summary: 'A time of day, in the home’s own timezone, optionally on chosen weekdays.',
    note:
      'An occurrence missed while the hub was off is not made up afterwards — a heater told to ' +
      'come on at seven should not come on at nine.',
  },
  {
    id: 'interval',
    summary: 'Every so often, while the hub is running.',
    note: `At most once every ${MIN_INTERVAL_MS / 1000} seconds.`,
  },
  {
    id: 'manual',
    summary: 'Somebody pressed it in the app.',
    note:
      'With offActions on the document this becomes a toggle — a mode like "Security" that is ' +
      'on or off — and without them it is a one-shot button like "I am leaving".',
  },
];

const CONDITIONS: CatalogEntry[] = [
  { id: 'deviceState', summary: 'A device is currently in some state.' },
  {
    id: 'timeRange',
    summary: 'The time of day is inside a window.',
    note: 'from 22:00 to 06:00 means one night, not an empty window.',
  },
  { id: 'dayOfWeek', summary: 'It is one of these weekdays (0 is Sunday).' },
  {
    id: 'automationActive',
    summary: 'Another automation is currently switched on.',
    note:
      'This is what makes a house of modes: "Security" is a toggle that does little itself, and ' +
      'every rule that should behave differently while it is on asks this.',
  },
  { id: 'all', summary: 'Every nested condition holds.' },
  { id: 'any', summary: 'At least one nested condition holds.' },
  { id: 'not', summary: 'The nested condition does not hold.' },
];

const ACTIONS: CatalogEntry[] = [
  {
    id: 'deviceCommand',
    summary: 'Tell one or more devices to do something.',
    note:
      'The target can name devices or select them ("every light in the Kitchen"). A selector ' +
      'keeps working as the home changes, which is why the shipped templates use one.',
  },
  {
    id: 'wait',
    summary: 'Pause before the next action.',
    note:
      `At most ${MAX_WAIT_MS / 60_000} minutes, because a wait does not survive a hub restart. ` +
      'Anything longer belongs in a schedule trigger.',
  },
  { id: 'setAutomationEnabled', summary: 'Switch another automation on or off entirely.' },
  { id: 'setAutomationActive', summary: 'Turn a manual toggle (a mode) on or off.' },
  { id: 'runAutomation', summary: 'Run another automation’s actions now.' },
  {
    id: 'logActivity',
    summary: 'Write one line into the home’s history.',
    note:
      'For something worth reading a week later. A rule that logs on every firing fills the feed ' +
      'and the disk.',
  },
];

/**
 * Per-path words. A path with no entry here still appears in the catalog with
 * its type and its continuity — the map is for the unit and the sentence,
 * which is exactly the part a generator cannot infer.
 */
const PATH_NOTES: Partial<Record<ReadablePath, { summary: string; unit?: string }>> = {
  onOff: { summary: 'Whether the device is switched on.' },
  'level.current': { summary: 'Brightness or dimmer position.', unit: '1–254 (not a percentage)' },
  'colorTemperature.mireds': {
    summary: 'Colour temperature.',
    unit: 'mireds — 153 is about 6500 K (cold), 500 is about 2000 K (warm)',
  },
  'thermostat.localTemperatureCenti': {
    summary: 'What the thermostat measures.',
    unit: 'hundredths of °C — 2150 is 21.5 °C',
  },
  'thermostat.occupiedHeatingSetpointCenti': {
    summary: 'The heating target.',
    unit: 'hundredths of °C',
  },
  'thermostat.occupiedCoolingSetpointCenti': {
    summary: 'The cooling target.',
    unit: 'hundredths of °C',
  },
  'thermostat.systemMode': { summary: 'Thermostat mode.', unit: '0 off, 1 auto, 3 cool, 4 heat' },
  lock: { summary: 'Lock state.', unit: '0 not fully locked, 1 locked, 2 unlocked' },
  'covering.currentPositionLiftPercent100ths': {
    summary: 'How far a blind or curtain is closed.',
    unit: 'hundredths of a percent, and 0 is fully OPEN — 10000 is fully closed',
  },
  'fan.mode': { summary: 'Fan mode.', unit: '0 off, 1 low, 2 medium, 3 high, 4 on, 5 auto' },
  'fan.percentCurrent': { summary: 'Fan speed.', unit: '0–100 percent' },
  'sensors.temperatureCenti': { summary: 'Measured temperature.', unit: 'hundredths of °C' },
  'sensors.humidityCenti': { summary: 'Relative humidity.', unit: 'hundredths of a percent' },
  'sensors.illuminanceLux': { summary: 'How bright the room is.', unit: 'lux' },
  'sensors.pressureHPa': { summary: 'Air pressure.', unit: 'hPa' },
  'sensors.flowCubicMetersPerHour': { summary: 'Flow rate.', unit: 'm³/h' },
  'sensors.occupied': { summary: 'Whether a motion or presence sensor sees somebody.' },
  'sensors.contactClosed': {
    summary: 'Whether a door or window contact is closed.',
    unit: 'true is closed, so an open door is false',
  },
  'sensors.airQuality': { summary: 'Air quality.', unit: '0 unknown, 1 good … 6 extremely poor' },
  'sensors.pm25': { summary: 'Fine particulates.', unit: 'µg/m³' },
  'sensors.co2ppm': { summary: 'Carbon dioxide.', unit: 'ppm' },
  'sensors.smokeAlarm': { summary: 'Smoke alarm.', unit: '0 normal, 1 warning, 2 critical' },
  'sensors.coAlarm': { summary: 'Carbon monoxide alarm.', unit: '0 normal, 1 warning, 2 critical' },
  'battery.percent': { summary: 'Battery left.', unit: '0–100 percent' },
  'power.activeMilliwatts': { summary: 'Power being drawn right now.', unit: 'milliwatts — 2000 is 2 W' },
  'power.importedEnergyMilliwattHours': { summary: 'Energy used in total.', unit: 'milliwatt-hours' },
  playbackPlaying: { summary: 'Whether media is playing.' },
  currentMode: { summary: 'The device’s selected mode, for devices that have a mode list.' },
  rvcOperationalState: {
    summary: 'What a robot vacuum is doing.',
    unit: '0 stopped, 1 running, 2 paused, 3 error, 64 seeking charger, 65 charging, 66 docked',
  },
  reachable: {
    summary: 'Whether the radio can reach this device.',
    unit: 'true is reachable',
  },
};

const COMMAND_NOTES: Record<string, { summary: string; note?: string }> = {
  power: { summary: 'Switch on or off.' },
  toggle: { summary: 'Flip whatever it currently is.' },
  setLevel: { summary: 'Set brightness or dimmer position.', note: '1–254, never a percentage.' },
  setColorTemperature: { summary: 'Set white colour temperature, in mireds.' },
  setHueSaturation: { summary: 'Set colour.', note: 'Hue and saturation are 0–254 cluster units.' },
  setHeatingSetpoint: { summary: 'Set the heating target, in hundredths of °C.' },
  setCoolingSetpoint: { summary: 'Set the cooling target, in hundredths of °C.' },
  setSystemMode: { summary: 'Set thermostat mode (0 off, 1 auto, 3 cool, 4 heat).' },
  lock: { summary: 'Lock or unlock.' },
  setCoveringPercent: {
    summary: 'Move a blind or curtain.',
    note: 'Hundredths of a percent, and 0 is fully open.',
  },
  openCovering: { summary: 'Open a blind or curtain fully.' },
  closeCovering: { summary: 'Close a blind or curtain fully.' },
  stopCovering: { summary: 'Stop a blind or curtain where it is.' },
  setFanPercent: { summary: 'Set fan speed, 0–100.' },
  setFanMode: { summary: 'Set fan mode (0 off … 5 auto).' },
  playPause: { summary: 'Play or pause media.' },
  setMode: { summary: 'Choose a mode from the device’s own list.' },
  irSend: { summary: 'Replay a learned infrared code by its id.' },
  setCustomField: {
    summary: 'Write one of the device’s own settings.',
    note:
      'These are settings rather than controls. On a battery device the write is queued until the ' +
      'device next wakes, which can be an hour — do not build a rule that depends on it landing now.',
  },
};

// ── Building it ──────────────────────────────────────────────────────────────

let cached: AutomationCatalog | null = null;

/**
 * The catalog, built once per process.
 *
 * Byte-identical for the life of a build, which is what lets it sit in the
 * agent's cached system prompt: the JSON Schema alone is ~26 KB, and re-sending
 * that on every round of every conversation is the cost the cache breakpoints
 * in `agent.ts` exist to avoid.
 */
export function automationCatalog(): AutomationCatalog {
  if (cached) return cached;

  const schema = z.toJSONSchema(automationDocumentSchema, { target: 'draft-7' }) as Record<
    string,
    unknown
  >;
  // Metadata about the document, not about what a rule may contain.
  delete schema.$schema;

  cached = {
    version: 1,
    schema,
    bounds: {
      minIntervalMs: MIN_INTERVAL_MS,
      maxWaitMs: MAX_WAIT_MS,
      maxActions: MAX_ACTIONS,
      maxFanOut: MAX_FAN_OUT,
      minHoldMs: MIN_HOLD_MS,
      maxConditionDepth: MAX_CONDITION_DEPTH,
    },
    modes: AUTOMATION_MODES,
    triggers: TRIGGERS,
    conditions: CONDITIONS,
    actions: ACTIONS,
    paths: READABLE_PATH_KEYS.map((path) => {
      const notes = PATH_NOTES[path];
      return {
        id: path,
        summary: notes?.summary ?? path,
        type: READABLE_PATHS[path].type,
        continuous: isContinuousPath(path),
        ...(notes?.unit !== undefined ? { unit: notes.unit } : {}),
      };
    }),
    commands: Object.entries(COMMAND_NOTES).map(([type, notes]) => ({
      id: type,
      summary: notes.summary,
      capability: commandCapability(type),
      ...(notes.note !== undefined ? { note: notes.note } : {}),
    })),
    capabilities: CAPABILITY_KINDS,
    deviceKinds: DEVICE_KINDS,
  };
  return cached;
}

/**
 * The catalog as prose, for the agent's system prompt.
 *
 * Not the JSON: the schema is handed to the model as a tool input schema,
 * where it belongs, and repeating it in the prompt would double the largest
 * thing in the request. What a prompt is good for is the half a schema cannot
 * say — which unit a number is in, why a threshold on a noisy reading is
 * refused, that 0 means open.
 */
export function catalogAsPrompt(): string {
  const catalog = automationCatalog();
  const lines: string[] = [];

  lines.push('TRIGGERS — what starts a rule:');
  for (const entry of catalog.triggers) {
    lines.push(`- ${entry.id}: ${entry.summary}${entry.note ? ` ${entry.note}` : ''}`);
  }

  lines.push('', 'CONDITIONS — what has to hold for it to go ahead:');
  for (const entry of catalog.conditions) {
    lines.push(`- ${entry.id}: ${entry.summary}${entry.note ? ` ${entry.note}` : ''}`);
  }

  lines.push('', 'ACTIONS — what it does:');
  for (const entry of catalog.actions) {
    lines.push(`- ${entry.id}: ${entry.summary}${entry.note ? ` ${entry.note}` : ''}`);
  }

  lines.push(
    '',
    'READABLE VALUES — what a trigger or condition can look at. Units are exact and are a',
    'contract with the apps; getting one wrong makes a rule that is wrong by a factor of a',
    'hundred and looks perfectly reasonable:',
  );
  for (const path of catalog.paths) {
    const unit = path.unit ? ` [${path.unit}]` : '';
    const continuous = path.continuous ? ' (varies continuously — needs "for" or "hysteresis")' : '';
    lines.push(`- ${path.id}: ${path.summary}${unit}${continuous}`);
  }

  lines.push('', 'COMMANDS — what an action can send, and what the target must have:');
  for (const command of catalog.commands) {
    const needs = command.capability ? ` (needs ${command.capability})` : '';
    lines.push(`- ${command.id}${needs}: ${command.summary}${command.note ? ` ${command.note}` : ''}`);
  }

  lines.push(
    '',
    'LIMITS the hub enforces whatever a document asks for:',
    `- an interval trigger runs at most every ${catalog.bounds.minIntervalMs / 1000}s`,
    `- a wait is at most ${catalog.bounds.maxWaitMs / 60_000} minutes and does not survive a restart`,
    `- at most ${catalog.bounds.maxActions} actions, and one selector resolves to at most ${catalog.bounds.maxFanOut} devices`,
    `- a threshold on a continuously-varying reading needs "for" of at least ${catalog.bounds.minHoldMs / 1000}s or a hysteresis band`,
  );

  return lines.join('\n');
}
