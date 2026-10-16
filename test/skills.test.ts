import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { HubEventBus } from '../src/core/bus.js';
import { ActivityService } from '../src/core/activity.js';
import { PairingService } from '../src/core/pairing.js';
import { SettingsService } from '../src/core/settings.js';
import { DeviceRegistry } from '../src/core/registry.js';
import { PermitJoinService } from '../src/core/permit-join.js';
import { AiRunLog } from '../src/core/ai-runs.js';
import { MappingLibrary } from '../src/ai/library.js';
import { KEY_GRANTABLE } from '../src/core/access.js';
import type { AutomationEngine } from '../src/automations/engine.js';
import type { ZodType } from 'zod';
import {
  CAPABILITY_KINDS,
  DEVICE_KINDS,
  commandSchema,
  endpointDescriptorSchema,
  isCapabilityKind,
  mqttDiscoverySchema,
  statePatchSchema,
} from '../src/schema/index.js';
import { commandTopic, parseTopic } from '../src/adapters/mqtt/convention.js';
import {
  bootedHome,
  loadedAccess,
  loadedFavorites,
  openTestDb,
  resetDb,
  startedAutomations,
  startedHistory,
  testBroker,
  testPortraits,
} from './helpers/db.js';

/**
 * The agent skills in `skills/`, held to the open standard, to the server and
 * to the schema.
 *
 * A skill is followed literally, by an agent on somebody else's machine, so a
 * route it names that does not exist, one it says a key can use when no key
 * can, a capability the hub has renamed or an example the hub would refuse is a
 * bug in every installed copy. Nothing else checks: no loader knows what this
 * hub serves. `skills/CLAUDE.md` is the prose behind each rule here.
 */

const repoRoot = path.join(import.meta.dirname, '..');
const skillsRoot = path.join(repoRoot, 'skills');

const readJson = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(repoRoot, file), 'utf8')) as Record<string, unknown>;

/** Every file under a directory, as paths relative to it. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((entry) => statSync(path.join(dir, entry)).isFile())
    .sort();
}

// ── The frontmatter subset ───────────────────────────────────────────────────

type Fields = Record<string, string | Record<string, string>>;

/**
 * One value, as every YAML reader would agree on it. A double-quoted value is
 * read as JSON, whose string syntax is a subset of YAML's. A plain value must
 * contain nothing a YAML parser could take for structure, and nothing it would
 * read as a number, a boolean or null — `metadata` is a map of strings.
 */
function scalar(raw: string, where: string): string {
  if (raw.startsWith('"')) {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'string') throw new Error(`${where}: not a string: ${raw}`);
    return value;
  }
  const structural = /^[-?:,[\]{}#&*!|>'"%@`]/.test(raw) || raw.includes(': ') || raw.includes(' #');
  const typed = /^(true|false|yes|no|on|off|null|~|[-+]?[0-9][0-9._]*)$/i.test(raw);
  if (structural || typed || raw.endsWith(':') || raw !== raw.trim()) {
    throw new Error(`${where}: quote this value — a YAML parser would not read it as plain text: ${raw}`);
  }
  return raw;
}

/**
 * The small YAML subset `skills/CLAUDE.md` allows: `key: value` on one line,
 * and a `key:` opening one level of two-space-indented `key: value` pairs.
 * Anything else is refused by name rather than guessed at, because loaders
 * read frontmatter with everything from a YAML library to a regex.
 */
function parseSubset(text: string, where: string): Fields {
  const fields: Fields = {};
  let map: Record<string, string> | null = null;
  for (const [index, line] of text.split('\n').entries()) {
    const at = `${where}:${index + 1}`;
    if (line.trim() === '') continue;
    const nested = /^ {2}([A-Za-z0-9_.-]+): (.+)$/.exec(line);
    if (nested && map) {
      map[nested[1]!] = scalar(nested[2]!, at);
      continue;
    }
    const top = /^([a-z][a-z0-9-]*):(?: (.+))?$/.exec(line);
    if (!top) throw new Error(`${at}: outside the frontmatter subset: ${line}`);
    if (top[1]! in fields) throw new Error(`${at}: ${top[1]} appears twice`);
    if (top[2] === undefined) {
      map = {};
      fields[top[1]!] = map;
    } else {
      map = null;
      fields[top[1]!] = scalar(top[2], at);
    }
  }
  return fields;
}

function skillFile(skill: string): { fields: Fields; body: string; lines: number } {
  const file = path.join(skillsRoot, skill, 'SKILL.md');
  const text = readFileSync(file, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error(`${file}: no frontmatter`);
  return {
    fields: parseSubset(match[1]!, path.relative(repoRoot, file)),
    body: text.slice(match[0].length),
    lines: text.split('\n').length,
  };
}

/** The six fields of the Agent Skills specification — and only those. */
const STANDARD_FIELDS = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];

const skills = readdirSync(skillsRoot)
  .filter((entry) => statSync(path.join(skillsRoot, entry)).isDirectory())
  .sort();

describe('the agent skills', () => {
  it('are the two this repository publishes', () => {
    // Pinned, so this file cannot pass by finding nothing — and so a skill
    // added or renamed is a decision someone writes down, since agents and
    // people refer to a skill by its name.
    expect(skills).toEqual(['gethome-hub-api', 'gethome-mqtt-device']);
  });

  it('refuses frontmatter outside the subset, so the parser is not a test of nothing', () => {
    expect(() => parseSubset('description: Use it: like this', 'x')).toThrow(/quote this value/);
    expect(() => parseSubset('metadata:\n  version: 1.0', 'x')).toThrow(/quote this value/);
    expect(() => parseSubset('description: >-\n  folded', 'x')).toThrow(/quote this value/);
    expect(() => parseSubset('- name', 'x')).toThrow(/outside the frontmatter subset/);
    expect(parseSubset('description: "Use it: like this"', 'x')).toEqual({ description: 'Use it: like this' });
  });

  describe.each(skills)('%s', (skill) => {
    const dir = path.join(skillsRoot, skill);
    const { fields, lines } = skillFile(skill);

    it('carries only the standard frontmatter fields, and the two it needs', () => {
      expect(Object.keys(fields).filter((key) => !STANDARD_FIELDS.includes(key))).toEqual([]);
      expect(typeof fields.name).toBe('string');
      expect(typeof fields.description).toBe('string');
      for (const key of ['license', 'compatibility', 'allowed-tools']) {
        if (key in fields) expect(typeof fields[key], key).toBe('string');
      }
      if ('metadata' in fields) expect(typeof fields.metadata).toBe('object');
    });

    it('is named for its directory, in lowercase words joined by single hyphens', () => {
      expect(fields.name).toBe(skill);
      expect(skill).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(skill.length).toBeLessThanOrEqual(64);
    });

    it('describes itself in at most 200 characters', () => {
      // The standard allows 1024; the Claude apps document 200 for an uploaded
      // skill, and the strictest reader sets the limit.
      const description = fields.description as string;
      expect(description.length).toBeGreaterThan(0);
      expect(description.length).toBeLessThanOrEqual(200);
      if (typeof fields.compatibility === 'string') {
        expect(fields.compatibility.length).toBeLessThanOrEqual(500);
      }
    });

    it('is licensed as the repository is', () => {
      expect(fields.license).toBe(readJson('package.json').license);
    });

    it('keeps SKILL.md under 500 lines', () => {
      expect(lines).toBeLessThan(500);
    });

    it('links only to files inside itself that exist', () => {
      for (const file of filesUnder(dir).filter((entry) => entry.endsWith('.md'))) {
        const text = readFileSync(path.join(dir, file), 'utf8');
        for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
          if (/^[a-z]+:/.test(target!) || target!.startsWith('#')) continue;
          const resolved = path.resolve(path.dirname(path.join(dir, file)), target!.split('#')[0]!);
          expect(path.relative(dir, resolved).startsWith('..'), `${file} → ${target}`).toBe(false);
          expect(() => statSync(resolved), `${file} → ${target}`).not.toThrow();
        }
      }
    });

    it('links every reference from SKILL.md', () => {
      const text = readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
      for (const file of filesUnder(dir).filter((entry) => entry.startsWith('references'))) {
        expect(text, file).toContain(`](${file.split(path.sep).join('/')})`);
      }
    });

  });
});

// ── Held to the schema ───────────────────────────────────────────────────────

const read = (skill: string, file: string) => readFileSync(path.join(skillsRoot, skill, file), 'utf8');

/** Every command the hub sends a device, read from the schema itself. */
const COMMAND_TYPES: readonly string[] = commandSchema.options.map((option) => [...option.shape.type.values][0]!);
const isCommandType = (value: unknown) => typeof value === 'string' && COMMAND_TYPES.includes(value);

/**
 * Learning, saving, renaming and deleting an IR code is a person at the blaster
 * with a remote in hand, so the API skill leaves those four out on purpose.
 * Anything else the hub learns to do, the skill learns too.
 */
const LEFT_TO_PEOPLE = ['irLearn', 'irSaveLearned', 'irRenameCommand', 'irDeleteCommand'];

/** The backticked words in the sentence that follows `marker`, split on commas. */
function listAfter(text: string, marker: string): string[] {
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`no "${marker}"`);
  const sentence = text.slice(start + marker.length).split(/\.(?:\s|$)/)[0]!;
  return [...sentence.matchAll(/`([^`]+)`/g)].flatMap(([, words]) =>
    words!.split(',').map((word) => word.trim()).filter(Boolean),
  );
}

/** A table's first column, where its rows start with a backticked word. */
const tableNames = (text: string) => [...text.matchAll(/^\| `([A-Za-z0-9]+)` \|/gm)].map(([, name]) => name!);

/** The third column of the same rows — in `capabilities.md`, the commands that arrive. */
const commandsColumn = (text: string) =>
  [...text.matchAll(/^\| `[A-Za-z0-9]+` \|[^|\n]*\|([^|\n]*)\|/gm)].flatMap(([, cell]) =>
    [...cell!.matchAll(/`([A-Za-z]+)/g)].map(([, name]) => name!),
  );

/** The topics in a table whose rows start with one. */
const topicRows = (text: string) => [...text.matchAll(/^\| `(gethome\/[^`]+)` \|/gm)].map(([, topic]) => topic!);

const tryJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * Every JSON value a skill shows: a `json` block whole or a line at a time, an
 * object on a line of any other block — a command after `←`, a dictionary in
 * Python — and a code span in the prose. A placeholder (`…`) is not JSON and
 * is passed over, which is the one way to show a shape without a value.
 */
function jsonExamples(text: string): unknown[] {
  const found: unknown[] = [];
  for (const [, lang, body] of text.matchAll(/```(\w*)\n([\s\S]*?)```/g)) {
    const whole = lang === 'json' ? tryJson(body!) : undefined;
    if (whole !== undefined) {
      found.push(whole);
      continue;
    }
    for (const line of body!.split('\n')) {
      const asLine = lang === 'json' ? tryJson(line.trim()) : undefined;
      if (asLine !== undefined) {
        found.push(asLine);
        continue;
      }
      for (const [candidate] of line.matchAll(/\{"[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)) {
        const value = tryJson(candidate);
        if (value !== undefined) found.push(value);
      }
    }
  }
  const prose = text.replace(/```[\s\S]*?```/g, '');
  for (const [, span] of prose.matchAll(/`(\{"[^`]*\})`/g)) {
    const value = tryJson(span!);
    if (value !== undefined) found.push(value);
  }
  return found;
}

/** Every command inside a value: one with a command's `type`, or under a `command` key. */
function* commandsWithin(value: unknown): Generator<unknown> {
  if (Array.isArray(value)) {
    for (const item of value) yield* commandsWithin(item);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  if (isCommandType((value as { type?: unknown }).type)) yield value;
  for (const [key, inner] of Object.entries(value)) {
    if (key === 'command') yield inner;
    else yield* commandsWithin(inner);
  }
}

describe('the skills, against the schema', () => {
  it('name every device kind, and no other', () => {
    for (const [skill, file, marker] of [
      ['gethome-mqtt-device', 'SKILL.md', '`deviceKind` is one of'],
      ['gethome-mqtt-device', 'references/convention.md', '**Device kinds**:'],
      ['gethome-hub-api', 'references/devices-and-commands.md', '## Device kinds'],
    ] as const) {
      expect(listAfter(read(skill, file), marker).sort(), `${skill}/${file}`).toEqual([...DEVICE_KINDS].sort());
    }
  });

  it('name every capability, and no other', () => {
    expect(listAfter(read('gethome-mqtt-device', 'references/convention.md'), '**Capabilities**:').sort()).toEqual(
      [...CAPABILITY_KINDS].sort(),
    );
    for (const [skill, file] of [
      ['gethome-mqtt-device', 'references/capabilities.md'],
      ['gethome-hub-api', 'references/devices-and-commands.md'],
    ] as const) {
      const text = read(skill, file);
      const rows = tableNames(text);
      expect(rows.length, file).toBeGreaterThan(20);
      expect(rows.filter((name) => !isCapabilityKind(name)), file).toEqual([]);
      // One the table leaves out is still named, with the reason — the device
      // skill says why `irRemote` is not its business.
      expect(CAPABILITY_KINDS.filter((kind) => !text.includes(`\`${kind}\``)), file).toEqual([]);
    }
  });

  it('name only commands the hub sends, and every one a key may send', () => {
    const named = commandsColumn(read('gethome-mqtt-device', 'references/capabilities.md'));
    expect(named.length).toBeGreaterThan(15);
    expect(named.filter((type) => !isCommandType(type))).toEqual([]);

    const listed = new Set(
      jsonExamples(read('gethome-hub-api', 'references/devices-and-commands.md'))
        .flatMap((example) => [...commandsWithin(example)])
        .map((command) => (command as { type?: unknown }).type),
    );
    expect(COMMAND_TYPES.filter((type) => !listed.has(type) && !LEFT_TO_PEOPLE.includes(type))).toEqual([]);
  });

  it('use the MQTT topics the hub reads and writes', () => {
    for (const file of ['SKILL.md', 'references/convention.md']) {
      const topics = topicRows(read('gethome-mqtt-device', file));
      expect(topics.length, file).toBeGreaterThanOrEqual(6);
      for (const topic of topics) {
        const concrete = topic.replace('<deviceId>', 'porch-light').replace('<endpointId>', '2');
        if (/\/set(?:\/|$)/.test(concrete)) {
          expect([commandTopic('porch-light', 1), commandTopic('porch-light', 2)], `${file}: ${topic}`).toContain(
            concrete,
          );
        } else {
          expect(parseTopic(concrete), `${file}: ${topic}`).not.toBeNull();
        }
      }
    }
  });

  it('show only examples the hub accepts', () => {
    // An agent copies an example before it reads the paragraph around it.
    const counted: Record<string, number> = {};
    const refused: string[] = [];
    const check = (kind: string, schema: ZodType, value: unknown, where: string) => {
      counted[kind] = (counted[kind] ?? 0) + 1;
      const result = schema.safeParse(value);
      if (!result.success) {
        refused.push(`${where}: ${kind} ${JSON.stringify(value)} — ${result.error.issues.map((issue) => issue.message).join('; ')}`);
      }
    };

    for (const skill of skills) {
      for (const file of filesUnder(path.join(skillsRoot, skill)).filter((entry) => entry.endsWith('.md'))) {
        const where = `${skill}/${file}`;
        for (const example of jsonExamples(read(skill, file))) {
          for (const command of commandsWithin(example)) check('command', commandSchema, command, where);
          // The API skill's other JSON is the hub's answers, which only the
          // device skill's examples are not.
          if (skill !== 'gethome-mqtt-device') continue;
          if (typeof example !== 'object' || example === null || Array.isArray(example)) continue;
          if ('type' in example) {
            if (!isCommandType(example.type)) check('command', commandSchema, example, where);
          } else if ('endpoints' in example) check('discovery document', mqttDiscoverySchema, example, where);
          else if ('endpointId' in example) check('endpoint', endpointDescriptorSchema, example, where);
          else check('state report', statePatchSchema, example, where);
        }
      }
    }

    expect(refused).toEqual([]);
    // Enough of each that the scan is plainly reaching them.
    expect(counted.command).toBeGreaterThan(40);
    expect(counted['discovery document']).toBeGreaterThanOrEqual(4);
    expect(counted.endpoint).toBeGreaterThanOrEqual(6);
    expect(counted['state report']).toBeGreaterThan(10);
  });
});

// ── Held to the server ───────────────────────────────────────────────────────

const handle = await openTestDb();
const silent = pino({ level: 'silent' });

/** `GET /api/v1/devices/{deviceId}` → method and a route pattern; parameters named `{…}`. */
const ROUTE = /\b(GET|POST|PUT|PATCH|DELETE) (\/api\/v1\/[A-Za-z0-9_\-/{}.]*)/g;
const asPattern = (url: string) => url.replace(/\{([^}]+)\}/g, ':$1').replace(/[./]+$/, '');
/** Parameter names differ between the docs and the server; their positions may not. */
const shape = (method: string, url: string) => `${method} ${asPattern(url).replace(/:[A-Za-z0-9_]+/g, ':_')}`;

function routesIn(text: string): Array<{ method: string; url: string }> {
  return [...text.matchAll(ROUTE)].map(([, method, url]) => ({ method: method!, url: asPattern(url!) }));
}

/** `references/rest-api.md`'s tables, by the heading above each. */
function restApiTables(): Map<string, string[][]> {
  const text = readFileSync(path.join(skillsRoot, 'gethome-hub-api', 'references', 'rest-api.md'), 'utf8');
  const tables = new Map<string, string[][]>();
  for (const section of text.split(/^## /m).slice(1)) {
    const heading = section.slice(0, section.indexOf('\n')).trim();
    const rows = section
      .split('\n')
      .filter((line) => line.startsWith('|') && !/^\|[-| ]+\|$/.test(line))
      .map((line) => line.slice(1, -1).split(' | ').map((cell) => cell.trim()))
      .slice(1); // the header row
    if (rows.length > 0) tables.set(heading, rows);
  }
  return tables;
}

describe.skipIf(!handle)('the skills, against the routes this hub serves', () => {
  const db = handle?.db!;
  let app: FastifyInstance;
  let engine: AutomationEngine;
  /** `shape` → the policy `server.ts` recorded for it. */
  let policies: Map<string, { policy: string; permission?: string }>;

  beforeAll(async () => {
    await resetDb(db);
    const dataDir = mkdtempSync(path.join(tmpdir(), 'gethome-skills-'));
    const events = new HubEventBus();
    const activity = new ActivityService(db, events);
    const access = await loadedAccess(db, events);
    const pairing = new PairingService(db, dataDir, silent, access);
    await pairing.boot();
    const registry = new DeviceRegistry(db, events, activity, silent);
    await registry.start();
    const settings = new SettingsService(db, Buffer.alloc(32).toString('base64'));
    const automations = await startedAutomations(db, events, registry, activity);
    engine = automations.engine;
    app = await buildServer({
      db,
      events,
      registry,
      favorites: await loadedFavorites(db, events),
      access,
      pairing,
      activity,
      automations: automations.engine,
      automationStore: automations.store,
      automationChat: automations.chat,
      assistantChat: automations.assistant,
      history: await startedHistory(db, events),
      portraits: testPortraits(db, events),
      settings,
      hubId: 'hub-skills-test',
      home: await bootedHome(db, 'Skills Hub'),
      version: '0.1.0-test',
      dataDir,
      radioBudget: 'one',
      z2mDataDir: path.join(dataDir, 'zigbee2mqtt'),
      zigbeeEnvFile: path.join(dataDir, 'zigbee.env'),
      mqtt: testBroker(),
      permitJoin: new PermitJoinService(undefined, silent, () => {}),
      aiRuns: new AiRunLog(db, events),
      mappings: new MappingLibrary({ db, settings, registry, log: silent }),
      log: silent,
    });
    await app.ready();
    policies = new Map(
      app.apiKeyPolicies
        .filter((row) => row.method !== 'HEAD')
        .map((row) => [shape(row.method, row.url), row]),
    );
  });

  afterAll(async () => {
    await engine.stop();
    await app.close();
    await handle?.close();
  });

  it('names only routes that exist', () => {
    const named = filesUnder(skillsRoot)
      .filter((file) => file.endsWith('.md'))
      .flatMap((file) =>
        routesIn(readFileSync(path.join(skillsRoot, file), 'utf8')).map((route) => ({ ...route, file })),
      );
    // Enough that the scan is plainly reaching the skills.
    expect(named.length).toBeGreaterThan(60);
    const missing = named.filter(
      ({ method, url }) => !app.hasRoute({ method: method as HTTPMethods, url }),
    );
    expect(missing).toEqual([]);
  });

  it('names every route a key can use', () => {
    // The other direction from the test above: a route added for keys and
    // left out of the skill is one no agent will ever find. What a key can
    // never reach — a permission it cannot be given, or a route that takes no
    // credential at all, such as `POST /pair` — has nothing to document.
    const dir = path.join(skillsRoot, 'gethome-hub-api');
    const named = new Set(
      filesUnder(dir)
        .filter((file) => file.endsWith('.md'))
        .flatMap((file) => routesIn(readFileSync(path.join(dir, file), 'utf8')))
        .map(({ method, url }) => shape(method, url)),
    );
    const reachable = [...policies.entries()]
      .filter(([key, row]) => {
        if (row.policy === 'deny') return false;
        if (row.policy === 'public') return key === 'GET /api/v1/hub';
        if (row.policy === 'permission') return (KEY_GRANTABLE as readonly string[]).includes(row.permission!);
        return true;
      })
      .map(([key]) => key);
    expect(reachable.length).toBeGreaterThan(40);
    expect(reachable.filter((key) => !named.has(key))).toEqual([]);
  });

  it('never sends a key to a route no key may use', () => {
    const dir = path.join(skillsRoot, 'gethome-hub-api');
    const denied = filesUnder(dir)
      .filter((file) => file.endsWith('.md'))
      .flatMap((file) => routesIn(readFileSync(path.join(dir, file), 'utf8')).map((route) => ({ ...route, file })))
      .filter(({ method, url }) => policies.get(shape(method, url))?.policy === 'deny');
    expect(denied).toEqual([]);
  });

  it('says exactly what a key can be given', () => {
    const grants = restApiTables()
      .get('What a key can be given')!
      .map(([grant]) => /^`([^`]+)`$/.exec(grant!)?.[1])
      .filter((grant): grant is string => grant !== undefined && grant !== 'control');
    expect(grants.sort()).toEqual([...KEY_GRANTABLE].sort());
  });

  it('puts every route under the policy its table claims', () => {
    const tables = restApiTables();
    const checked: string[] = [];
    const policyOf = (method: string, url: string) => {
      const row = policies.get(shape(method, url));
      expect(row, `${method} ${url}`).toBeDefined();
      checked.push(`${method} ${url}`);
      return row!;
    };

    for (const [route] of tables.get('Reading (any key)')!) {
      for (const { method, url } of routesIn(route!)) {
        // `public`: `GET /hub`, which needs no credential at all.
        expect(['read', 'public'], `${method} ${url}`).toContain(policyOf(method, url).policy);
      }
    }
    for (const [route] of tables.get('Working the home (`control`)')!) {
      for (const { method, url } of routesIn(route!)) {
        // `handler`: the route asks for itself — `PATCH /devices/:id`, where
        // the caller's own favorite takes `control` and a rename a permission.
        expect(['control', 'handler'], `${method} ${url}`).toContain(policyOf(method, url).policy);
      }
    }
    for (const [route, needs] of tables.get('With a permission')!) {
      const permission = /`([a-z]+\.[a-z.]+)`/.exec(needs!)?.[1];
      expect(permission, route).toBeDefined();
      expect(KEY_GRANTABLE as readonly string[], route).toContain(permission);
      for (const { method, url } of routesIn(route!)) {
        const row = policyOf(method, url);
        if (row.policy === 'handler') continue;
        expect(`${row.policy} ${row.permission}`, `${method} ${url}`).toBe(`permission ${permission}`);
      }
    }
    // Every table was read, rather than a heading renamed out from under it.
    expect(checked.length).toBeGreaterThan(40);
  });
});
