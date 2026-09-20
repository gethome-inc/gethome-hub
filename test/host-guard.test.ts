import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import WebSocket from 'ws';
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
import {
  createHostCheck,
  createRefusalLogGate,
  hostnameFromHeader,
  isLocalHostname,
} from '../src/api/host-guard.js';
import {
  startedAutomations,
  bootedHome,
  loadedAccess,
  loadedFavorites,
  openTestDb,
  resetDb,
  startedHistory,
  testBroker,
  testPortraits,
} from './helpers/db.js';

const handle = await openTestDb();
const log = pino({ level: 'silent' });

describe('hostnameFromHeader', () => {
  it('strips the port from a name and an IPv4 literal', () => {
    expect(hostnameFromHeader('raspberrypi.local:8420')).toBe('raspberrypi.local');
    expect(hostnameFromHeader('192.168.1.50:8420')).toBe('192.168.1.50');
    expect(hostnameFromHeader('localhost')).toBe('localhost');
  });

  it('unwraps a bracketed IPv6 and leaves a bare one whole', () => {
    expect(hostnameFromHeader('[::1]:8420')).toBe('::1');
    expect(hostnameFromHeader('[fe80::1]')).toBe('fe80::1');
    // The case a last-colon split gets wrong: no port, several colons.
    expect(hostnameFromHeader('::1')).toBe('::1');
    expect(hostnameFromHeader('fe80::1')).toBe('fe80::1');
  });

  it('lowercases and drops a trailing root dot', () => {
    expect(hostnameFromHeader('Hub.LOCAL.')).toBe('hub.local');
    // The same normalisation is what stops `evil.com.` dodging the suffix test.
    expect(hostnameFromHeader('evil.com.')).toBe('evil.com');
  });

  it('treats an absent header as an empty name', () => {
    expect(hostnameFromHeader(undefined)).toBe('');
    expect(hostnameFromHeader('   ')).toBe('');
  });

  /**
   * Malformed input cannot reach this from the attack it defends against — a
   * browser builds `Host` from a URL authority and cannot be made to send
   * rubbish — and anyone able to set the header by hand could set it to
   * `localhost` anyway. So the bar here is only that nothing throws: a guard
   * on `onRequest` that can raise is a hub that answers 500 to every request.
   */
  it('parses anything without throwing', () => {
    for (const header of ['[', ']', '[]', ':', '::', ':::', '...', '\u0000', 'a'.repeat(5000)]) {
      expect(() => hostnameFromHeader(header)).not.toThrow();
      expect(() => isLocalHostname(hostnameFromHeader(header))).not.toThrow();
    }
  });
});

describe('isLocalHostname', () => {
  it('accepts every way a hub is legitimately reached', () => {
    for (const host of [
      '192.168.1.50', // an app connecting by address
      '10.0.0.4',
      '127.0.0.1', // update-runner.sh
      '::1',
      'fe80::1',
      '::ffff:192.168.1.50',
      'localhost', // install.sh's health check
      'raspberrypi', // a bare machine name
      'gethome-hub',
      'raspberrypi.local', // mDNS, which is how the apps find it
      'hub.home.arpa',
      'hub.home',
      'hub.lan',
      'hub.internal',
    ]) {
      expect(isLocalHostname(host), host).toBe(true);
    }
  });

  it('refuses a registrable public name, which is the only thing rebinding can use', () => {
    for (const host of [
      'evil.com',
      'attacker.example',
      'gethome.io',
      'rebind.evil.co.uk',
      // Ends *in* an allowed word without the dot — the `endsWith` trap that
      // `page-fetch.ts` names for its own allowlist.
      'notlocal',
      'evil-local.com',
    ]) {
      expect(isLocalHostname(host), host).toBe(host === 'notlocal');
    }
  });

  it('accepts a missing header, because a browser always sends one', () => {
    expect(isLocalHostname('')).toBe(true);
  });
});

describe('createHostCheck', () => {
  it('adds to the local rule rather than replacing it', () => {
    const check = createHostCheck('hub.example.com');
    expect(check('hub.example.com:8420')).toBe(true);
    // The whole reason it is additive: a phone still reaches this hub by address.
    expect(check('192.168.1.50:8420')).toBe(true);
    expect(check('raspberrypi.local')).toBe(true);
    expect(check('evil.com')).toBe(false);
  });

  it('parses a comma-separated list and ignores blanks', () => {
    const check = createHostCheck(' a.example.com , ,b.example.com ');
    expect(check('a.example.com')).toBe(true);
    expect(check('b.example.com')).toBe(true);
    expect(check('c.example.com')).toBe(false);
  });

  it('matches an extra host case-insensitively', () => {
    expect(createHostCheck('Hub.Example.COM')('hub.example.com')).toBe(true);
  });

  it('switches off entirely on "*"', () => {
    const check = createHostCheck('*');
    expect(check('evil.com')).toBe(true);
  });

  it('allows the local set when nothing is configured', () => {
    for (const extra of [undefined, '', []] as const) {
      const check = createHostCheck(extra);
      expect(check('localhost:8420')).toBe(true);
      expect(check('evil.com')).toBe(false);
    }
  });
});

describe('createRefusalLogGate', () => {
  it('writes one line per name and then stops', () => {
    const gate = createRefusalLogGate(3);
    expect(gate('a.com')).toBe(true);
    expect(gate('a.com')).toBe(false); // already said
    expect(gate('b.com')).toBe(true);
    expect(gate('c.com')).toBe(true);
    // The bound, because the names are the attacker's to invent.
    expect(gate('d.com')).toBe(false);
  });
});

describe.skipIf(!handle)('the Host guard over a real server', () => {
  const db = handle?.db!;
  let app: FastifyInstance;
  let dataDir: string;
  let port: number;
  let token: string;

  beforeAll(async () => {
    await resetDb(db);
    dataDir = mkdtempSync(path.join(tmpdir(), 'gethome-host-'));
    const events = new HubEventBus();
    const activity = new ActivityService(db, events);
    const access = await loadedAccess(db, events);
    const pairing = new PairingService(db, dataDir, log, access);
    await pairing.boot();
    const registry = new DeviceRegistry(db, events, activity, log);
    await registry.start();
    const settings = new SettingsService(db, Buffer.alloc(32).toString('base64'));
    const {
      engine: automations,
      store: automationStore,
      chat: automationChat,
      assistant: assistantChat,
    } = await startedAutomations(db, events, registry, activity);
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
      assistantChat,
      history: await startedHistory(db, events),
      portraits: testPortraits(db, events),
      settings,
      hubId: 'hub-host-test',
      home: await bootedHome(db, 'Host Hub'),
      version: '0.1.0-test',
      dataDir,
      // One real name beyond the local set, so the escape hatch is covered
      // over the wire and not only as a unit.
      allowedHosts: 'hub.example.com',
      radioBudget: 'one',
      z2mDataDir: path.join(dataDir, 'zigbee2mqtt'),
      zigbeeEnvFile: path.join(dataDir, 'zigbee.env'),
      mqtt: testBroker(),
      permitJoin: new PermitJoinService(undefined, log, () => {}),
      aiRuns: new AiRunLog(db, events),
      mappings: new MappingLibrary({ db, settings, registry, log }),
    });
    // A real socket, because the WebSocket half cannot be reached by `inject`.
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    port = typeof address === 'object' && address ? address.port : 0;

    const code = readFileSync(path.join(dataDir, 'pairing-code'), 'utf8').trim();
    const claimed = await app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      payload: { code, memberName: 'Georgy' },
    });
    expect(claimed.statusCode).toBe(200);
    token = (claimed.json() as { token: string }).token;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('serves every host a real client arrives on', async () => {
    for (const host of [
      'localhost:8420', // install.sh's health check
      '127.0.0.1:8420', // update-runner.sh
      '192.168.1.50:8420', // an app connecting by address
      '[::1]:8420',
      'raspberrypi.local:8420', // mDNS — how the apps find it
      'raspberrypi',
      'hub.example.com', // EXTRA_ALLOWED_HOSTS
    ]) {
      const response = await app.inject({ method: 'GET', url: '/api/v1/hub', headers: { host } });
      expect(response.statusCode, host).toBe(200);
    }
  });

  it('refuses a public name on the public route, which is what rebinding reads', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/hub',
      headers: { host: 'evil.com' },
    });
    expect(response.statusCode).toBe(403);
    // The name is echoed, so somebody who reached their own hub by an
    // unanticipated name knows what to put in EXTRA_ALLOWED_HOSTS.
    expect(response.json()).toEqual({ error: 'host_not_allowed', host: 'evil.com' });
  });

  it('refuses before the token is even looked at', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/devices',
      headers: { host: 'evil.com', authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: string }).error).toBe('host_not_allowed');
  });

  it('refuses the unauthenticated claim route too', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      headers: { host: 'evil.com' },
      payload: { code: '00000000', memberName: 'x' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('still answers that same request on a local host', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/devices',
      headers: { host: 'raspberrypi.local:8420', authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
  });

  /**
   * The upgrade is where a hook placed per-route would have missed: a socket
   * authorizes once and then streams the home, so a rebound page holding one
   * is the whole API rather than one request.
   */
  it('refuses a WebSocket upgrade under a rebound name', async () => {
    const outcome = await new Promise<{ opened: boolean; status?: number }>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws?token=${token}`, {
        headers: { host: 'evil.com' },
      });
      let opened = false;
      socket.on('open', () => {
        opened = true;
        socket.close();
      });
      // The status is asserted rather than merely "it didn't open": a refusal
      // for some other reason would look identical from the outside, and a
      // test that cannot reach what it is about is a test of nothing.
      socket.on('unexpected-response', (_request, response) => {
        socket.terminate();
        const { statusCode } = response;
        resolve({ opened, ...(statusCode !== undefined ? { status: statusCode } : {}) });
      });
      socket.on('close', () => resolve({ opened }));
      // `ws` emits `error` after `unexpected-response` as well, by which point
      // the promise has settled. Swallowed rather than resolved, so it can
      // never win the race against the status this test is actually about; a
      // failure with no response at all is caught by the deadline below.
      socket.on('error', () => {});
      setTimeout(() => reject(new Error('the upgrade neither opened nor was refused')), 4000);
    });
    expect(outcome.opened).toBe(false);
    expect(outcome.status).toBe(403);
  });

  it('accepts the same upgrade on a local name', async () => {
    const hello = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws?token=${token}`, {
        headers: { host: 'raspberrypi.local' },
      });
      socket.on('message', (raw) => {
        socket.close();
        resolve(String(raw));
      });
      socket.on('error', reject);
      setTimeout(() => reject(new Error('no hello frame')), 4000);
    });
    expect(JSON.parse(hello)).toMatchObject({ type: 'hello' });
  });
});
