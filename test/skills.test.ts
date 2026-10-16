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
 * The agent skills in `plugins/gethome/`, held to the open standard and to the
 * server.
 *
 * A skill is followed literally, by an agent on somebody else's machine, so a
 * route it names that does not exist — or one it says a key can use when no
 * key can — is a bug that ships to every installed copy. Nothing else checks:
 * Claude Code's validator reads the manifests and not the skills' frontmatter,
 * and no loader knows what this hub serves. `plugins/CLAUDE.md` is the prose
 * behind each rule here.
 */

const repoRoot = path.join(import.meta.dirname, '..');
const pluginRoot = path.join(repoRoot, 'plugins', 'gethome');
const skillsRoot = path.join(pluginRoot, 'skills');

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
 * The small YAML subset `plugins/CLAUDE.md` allows: `key: value` on one line,
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
  it('are the two this plugin publishes', () => {
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

    it('is licensed as the plugin is', () => {
      expect(fields.license).toBe(readJson('plugins/gethome/.claude-plugin/plugin.json').license);
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

    it('keeps its Codex metadata within what Codex reads', () => {
      const yaml = readFileSync(path.join(dir, 'agents', 'openai.yaml'), 'utf8');
      const parsed = parseSubset(yaml, `${skill}/agents/openai.yaml`);
      expect(Object.keys(parsed)).toEqual(['interface']);
      const ui = parsed.interface as Record<string, string>;
      expect(ui.display_name!.length).toBeLessThanOrEqual(64);
      expect(ui.short_description!.length).toBeLessThanOrEqual(1024);
      expect(ui.default_prompt!.length).toBeLessThanOrEqual(1024);
    });
  });
});

// ── The manifests ────────────────────────────────────────────────────────────

describe('the plugin and its two catalogs', () => {
  const claude = readJson('plugins/gethome/.claude-plugin/plugin.json');
  const portable = readJson('plugins/gethome/plugin.json');

  it('give the plugin one identity in both manifests', () => {
    // Claude Code and Codex cache an installed plugin by its version, so the
    // version is raised with every change (CI's *Plugin version* job) — and
    // in both files, or the two clients would disagree about what is installed.
    for (const key of ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords']) {
      expect(portable[key], key).toEqual(claude[key]);
    }
    expect(claude.name).toBe('gethome');
    expect(claude.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('keep the portable manifest to the Agent Plugins schema, which Codex reads only with its $schema', () => {
    expect(portable.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
    const allowed = ['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'];
    expect(Object.keys(portable).filter((key) => !allowed.includes(key))).toEqual([]);
    expect(Object.keys(portable.author as object).filter((key) => !['name', 'email', 'url'].includes(key))).toEqual([]);
    expect(portable.name).toMatch(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
  });

  it('list it under the same name, from the same directory, in both catalogs', () => {
    const forClaude = readJson('.claude-plugin/marketplace.json');
    const forCodex = readJson('.agents/plugins/marketplace.json');
    expect(forClaude.name).toBe('gethome');
    expect(forCodex.name).toBe('gethome');
    const [claudeEntry, ...moreClaude] = forClaude.plugins as Array<Record<string, unknown>>;
    const [codexEntry, ...moreCodex] = forCodex.plugins as Array<Record<string, unknown>>;
    expect(moreClaude).toEqual([]);
    expect(moreCodex).toEqual([]);
    // Codex refuses a plugin whose manifest name differs from its entry.
    expect(claudeEntry!.name).toBe(claude.name);
    expect(codexEntry!.name).toBe(claude.name);
    // A string, starting `./`: the form Claude Code, Codex and the `skills`
    // installer all read.
    expect(claudeEntry!.source).toBe('./plugins/gethome');
    expect(codexEntry!.source).toEqual({ source: 'local', path: './plugins/gethome' });
    // A version in the entry would only be overruled by plugin.json.
    expect(claudeEntry!.version).toBeUndefined();
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
    const named = filesUnder(pluginRoot)
      .filter((file) => file.endsWith('.md'))
      .flatMap((file) =>
        routesIn(readFileSync(path.join(pluginRoot, file), 'utf8')).map((route) => ({ ...route, file })),
      );
    // Enough that the scan is plainly reaching the skills.
    expect(named.length).toBeGreaterThan(60);
    const missing = named.filter(
      ({ method, url }) => !app.hasRoute({ method: method as HTTPMethods, url }),
    );
    expect(missing).toEqual([]);
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
