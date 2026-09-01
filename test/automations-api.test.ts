import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { HubEventBus } from '../src/core/bus.js';
import { ActivityService } from '../src/core/activity.js';
import { PairingService } from '../src/core/pairing.js';
import { SettingsService } from '../src/core/settings.js';
import { DeviceRegistry } from '../src/core/registry.js';
import { PermitJoinService } from '../src/core/permit-join.js';
import { AiRunLog } from '../src/core/ai-runs.js';
import { MappingLibrary } from '../src/ai/library.js';
import { automations as automationsTable } from '../src/db/schema.js';
import type { AutomationEngine } from '../src/automations/engine.js';
import {
  bootedHome,
  loadedAccess,
  loadedFavorites,
  openTestDb,
  startedAutomations,
  startedHistory,
  testBroker,
  testPortraits,
} from './helpers/db.js';

/**
 * The automation routes over a real server.
 *
 * What the domain suites cannot cover: the guards on each route, the
 * refusals a client actually sees, and the two words that must not be
 * confused — `enabled` (editing the rule) against `active` (working the home).
 */

const handle = await openTestDb();
const log = pino({ level: 'silent' });

let app: FastifyInstance;
let engine: AutomationEngine;
let token: string;

const auth = (value: string) => ({ authorization: `Bearer ${value}` });

beforeAll(async () => {
  const db = handle!.db;
  const dir = mkdtempSync(path.join(tmpdir(), 'gethome-automations-api-'));
  const events = new HubEventBus();
  const access = await loadedAccess(db, events);
  const pairing = new PairingService(db, dir, log, access);
  await pairing.boot();
  const activity = new ActivityService(db, events);
  const registry = new DeviceRegistry(db, events, activity, log);
  const settings = new SettingsService(db, Buffer.alloc(32).toString('base64'));
  const {
    engine: automations,
    store: automationStore,
    chat: automationChat,
  } = await startedAutomations(db, events, registry, activity, { settings });
  engine = automations;

  app = await buildServer({
    db,
    log,
    events,
    registry,
    favorites: await loadedFavorites(db, events),
    access,
    pairing,
    activity,
    automations,
    automationStore,
    automationChat,
    history: await startedHistory(db, events),
    portraits: testPortraits(db, events),
    settings,
    home: await bootedHome(db, 'Automation Hub'),
    hubId: 'hub-automations-test',
    version: '0.1.0-test',
    dataDir: dir,
    radioBudget: 'one',
    z2mDataDir: path.join(dir, 'zigbee2mqtt'),
    mqtt: testBroker(),
    permitJoin: new PermitJoinService(undefined, log, () => {}),
    aiRuns: new AiRunLog(db, events),
    mappings: new MappingLibrary({ db, settings, registry, log }),
  });

  const code = readFileSync(path.join(dir, 'pairing-code'), 'utf8').trim();
  const claimed = await app.inject({
    method: 'POST',
    url: '/api/v1/pair',
    payload: { code, memberName: 'Georgy', deviceName: 'MacBook' },
  });
  token = (claimed.json() as { token: string }).token;
});

afterAll(async () => {
  await engine?.stop();
  await app?.close();
  await handle?.close();
});

const button = {
  name: 'I’m leaving',
  triggers: [{ kind: 'manual' }],
  actions: [{ kind: 'logActivity', message: 'Everyone out' }],
};

/**
 * `object`, never `unknown`: narrowing `unknown` leaves `{} | null`, which is
 * not an inject payload, so Fastify quietly resolves `app.inject` to its
 * *chainable* overload and every `statusCode` in this file stops being checked
 * along with it.
 */
async function create(payload: object) {
  return app.inject({ method: 'POST', url: '/api/v1/automations', headers: auth(token), payload });
}

describe('creating a rule', () => {
  it('saves it switched off, and says what it does in a sentence', async () => {
    const response = await create(button);
    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      id: string;
      enabled: boolean;
      shape: string;
      summary: string;
    };
    // The one moment somebody can still look at what is about to start
    // happening in their house.
    expect(body.enabled).toBe(false);
    expect(body.shape).toBe('button');
    expect(body.summary).toContain('When somebody presses it');

    await app.inject({ method: 'DELETE', url: `/api/v1/automations/${body.id}`, headers: auth(token) });
  });

  it('refuses a document the schema does not know, with the path that is wrong', async () => {
    const response = await create({ ...button, triggers: [{ kind: 'sunrise' }] });
    expect(response.statusCode).toBe(422);
    const body = response.json() as { error: string; issues: { path: string }[] };
    expect(body.error).toBe('invalid_automation');
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it('refuses a threshold that would fire on every wobble, and says why', async () => {
    const response = await create({
      name: 'Washing machine',
      triggers: [
        {
          kind: 'deviceState',
          target: { select: { capability: 'electricalPower' } },
          path: 'power.activeMilliwatts',
          op: 'lt',
          value: 2_000,
        },
      ],
      actions: [{ kind: 'logActivity', message: 'done' }],
    });
    expect(response.statusCode).toBe(422);
    const body = response.json() as { problems: string[] };
    expect(body.problems.join(' ')).toContain('changes continuously');
  });

  it('accepts a rule that matches nothing yet, and warns', async () => {
    // The shape every shipped template has in a home with nothing paired.
    const response = await create({
      name: 'Lights out',
      triggers: [{ kind: 'manual' }],
      actions: [
        {
          kind: 'deviceCommand',
          target: { select: { kind: 'light', capability: 'onOff' } },
          command: { type: 'power', on: false },
        },
      ],
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { id: string; warnings: string[] };
    expect(body.warnings.join(' ')).toContain('matches nothing in this home yet');
    await app.inject({ method: 'DELETE', url: `/api/v1/automations/${body.id}`, headers: auth(token) });
  });
});

describe('dry run', () => {
  it('checks a document without saving it', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/automations/dry-run',
      headers: auth(token),
      payload: button,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ problems: [], shape: 'button' });

    const list = await app.inject({ method: 'GET', url: '/api/v1/automations', headers: auth(token) });
    expect((list.json() as { automations: unknown[] }).automations).toHaveLength(0);
  });
});

describe('pressing and enabling are different things', () => {
  it('refuses to press a rule that is switched off', async () => {
    const created = await create(button);
    const { id } = created.json() as { id: string };

    const pressed = await app.inject({
      method: 'POST',
      url: `/api/v1/automations/${id}/run`,
      headers: auth(token),
    });
    expect(pressed.statusCode).toBe(409);
    expect(pressed.json()).toMatchObject({ error: 'automation_disabled' });

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/automations/${id}`,
      headers: auth(token),
      payload: { enabled: true },
    });
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/automations/${id}/run`,
      headers: auth(token),
    });
    expect(again.statusCode).toBe(202);
    await app.inject({ method: 'DELETE', url: `/api/v1/automations/${id}`, headers: auth(token) });
  });

  it('refuses to switch a button on as if it were a mode', async () => {
    const created = await create(button);
    const { id } = created.json() as { id: string };
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/automations/${id}`,
      headers: auth(token),
      payload: { enabled: true },
    });

    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/automations/${id}/active`,
      headers: auth(token),
      payload: { active: true },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'not_a_toggle' });
    await app.inject({ method: 'DELETE', url: `/api/v1/automations/${id}`, headers: auth(token) });
  });

  it('switches a mode on and off', async () => {
    const created = await create({
      ...button,
      name: 'Security',
      offActions: [{ kind: 'logActivity', message: 'disarmed' }],
    });
    const { id, shape } = created.json() as { id: string; shape: string };
    expect(shape).toBe('toggle');
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/automations/${id}`,
      headers: auth(token),
      payload: { enabled: true },
    });

    const on = await app.inject({
      method: 'PUT',
      url: `/api/v1/automations/${id}/active`,
      headers: auth(token),
      payload: { active: true },
    });
    expect(on.statusCode).toBe(200);
    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/automations/${id}`,
      headers: auth(token),
    });
    expect(read.json()).toMatchObject({ active: true, enabled: true });
    await app.inject({ method: 'DELETE', url: `/api/v1/automations/${id}`, headers: auth(token) });
  });
});

describe('editing', () => {
  it('keeps what it used to say, and can go back to it', async () => {
    const created = await create(button);
    const { id } = created.json() as { id: string };

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/automations/${id}`,
      headers: auth(token),
      payload: { document: { ...button, name: 'Renamed' } },
    });
    const renamed = await app.inject({
      method: 'GET',
      url: `/api/v1/automations/${id}`,
      headers: auth(token),
    });
    expect((renamed.json() as { name: string }).name).toBe('Renamed');

    const versions = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/automations/${id}/versions`,
        headers: auth(token),
      })
    ).json() as { id: string; note: string }[];
    // "created", then the copy taken before the edit.
    expect(versions.length).toBeGreaterThanOrEqual(2);

    const original = versions.at(-1)!;
    const reverted = await app.inject({
      method: 'POST',
      url: `/api/v1/automations/${id}/revert`,
      headers: auth(token),
      payload: { versionId: original.id },
    });
    expect(reverted.statusCode).toBe(200);
    expect((reverted.json() as { name: string }).name).toBe('I’m leaving');
    await app.inject({ method: 'DELETE', url: `/api/v1/automations/${id}`, headers: auth(token) });
  });
});

describe('templates', () => {
  it('lists what is on offer and installs one', async () => {
    const listed = (
      await app.inject({ method: 'GET', url: '/api/v1/automations/templates', headers: auth(token) })
    ).json() as { key: string; inputs: unknown[] }[];
    expect(listed.map((entry) => entry.key)).toContain('away');

    const installed = await app.inject({
      method: 'POST',
      url: '/api/v1/automations/templates/motion_light',
      headers: auth(token),
      payload: {},
    });
    // It needs a room, and there is none — a clear refusal beats a rule
    // pointed at nothing.
    expect(installed.statusCode).toBe(400);

    const away = await app.inject({
      method: 'POST',
      url: '/api/v1/automations/templates/away',
      headers: auth(token),
      payload: {},
    });
    expect(away.statusCode).toBe(201);
    const body = away.json() as { automations: { id: string; enabled: boolean }[] };
    expect(body.automations).toHaveLength(1);
    expect(body.automations[0]?.enabled).toBe(false);
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/automations/${body.automations[0]!.id}`,
      headers: auth(token),
    });
  });

  it('refuses a template it has never heard of', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/automations/templates/teleport',
      headers: auth(token),
      payload: {},
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('the catalog and the clock', () => {
  it('serves what a rule can be made of, generated from the schema', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/automations/capabilities',
      headers: auth(token),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { triggers: { id: string }[]; schema: object };
    expect(body.triggers.map((entry) => entry.id)).toContain('manual');
    expect(body.schema).toHaveProperty('properties');
  });

  it('sets the home’s timezone and refuses one Intl cannot use', async () => {
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/timezone',
      headers: auth(token),
      payload: { timezone: 'Mars/Olympus' },
    });
    // Refused where somebody is still holding the request, rather than taking
    // every schedule in the home down on every tick.
    expect(bad.statusCode).toBe(400);

    const good = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/timezone',
      headers: auth(token),
      payload: { timezone: 'Europe/Lisbon' },
    });
    expect(good.statusCode).toBe(200);
    const read = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/timezone',
      headers: auth(token),
    });
    expect(read.json()).toEqual({ timezone: 'Europe/Lisbon' });
  });
});

describe('a rule this build cannot read', () => {
  it('is listed as unreadable rather than vanishing', async () => {
    await handle!.db.insert(automationsTable).values({
      name: 'From the future',
      enabled: true,
      document: { version: 1, name: 'From the future', triggers: [{ kind: 'eclipse' }], actions: [] },
    });
    await engine.reload();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/automations',
      headers: auth(token),
    });
    const body = response.json() as {
      automations: unknown[];
      unreadable: { name: string; problem: string }[];
    };
    // An app that simply did not list it would show a rule silently vanishing
    // after `install.sh` rolled a build back.
    expect(body.unreadable).toHaveLength(1);
    expect(body.unreadable[0]?.name).toBe('From the future');
  });
});

/**
 * Starting a conversation, and the two ways it can be refused.
 *
 * **The route must never answer 500 for a home that is merely configured for
 * something else.** It did: a home whose only key is OpenAI's threw an
 * `AiUnavailableError` past the refusal handler, Fastify turned it into
 * `{"statusCode":500,…}`, and the app — which reads `error`/`detail` — printed
 * "The hub answered 500." over a hub that was working perfectly.
 */
describe('starting a conversation', () => {
  const settings = new SettingsService(handle!.db, Buffer.alloc(32).toString('base64'));

  const start = () =>
    app.inject({
      method: 'POST',
      url: '/api/v1/automations/chat',
      headers: auth(token),
      payload: { message: 'turn the hall light on when someone walks past after dark' },
    });

  afterEach(async () => {
    await settings.clearAiProvider('anthropic');
    await settings.clearAiProvider('openai');
    await settings.setAiEnabled(true);
  });

  it('refuses a home with no key at all, in the shape an app can read', async () => {
    const response = await start();
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'ai_not_configured' });
  });

  it('refuses a home whose only key is OpenAI’s with a code and a sentence', async () => {
    await settings.setAiKey('openai', 'sk-openai-only');

    const response = await start();

    // 409 and not 500: the home is configured, just not for this.
    expect(response.statusCode).toBe(409);
    const body = response.json() as { error: string; detail?: string };
    expect(body.error).toBe('automation_needs_anthropic');
    // The sentence rides along, so an app that has never met the code still
    // shows something true rather than a status number.
    expect(body.detail).toMatch(/Anthropic key/);
  });

  it('says AI is switched off rather than unconfigured', async () => {
    await settings.setAiKey('anthropic', 'sk-ant-api03-test');
    await settings.setAiEnabled(false);

    const response = await start();

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'ai_disabled' });
  });
});
