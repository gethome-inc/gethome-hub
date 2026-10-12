import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { proofAddressHost, proofMessage, proofTokenId, proveIdentity } from '../src/core/hub-proof.js';
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

/**
 * `POST /hub/proof` — a hub proving it is itself at an address, to an app
 * that holds one of its tokens, before the app sends that token there. What an
 * app does with the answer is its own half; this pins the hub's: the bytes the
 * proof covers (the two apps mirror them), and the two refusals that make it
 * a proof rather than an echo.
 */

const handle = await openTestDb();
const log = pino({ level: 'silent' });

/** What an app computes, written out here rather than imported, as an app would. */
function asAnApp(token: string, hubId: string, nonce: string, address: string) {
  const key = createHash('sha256').update(token, 'utf8').digest();
  return {
    tokenId: createHash('sha256').update(key).digest('hex'),
    expected: createHmac('sha256', key)
      .update(`gethome-hub-proof\n${hubId}\n${nonce}\n${address}`, 'utf8')
      .digest('hex'),
  };
}

describe('the proof itself', () => {
  // The apps compute this in Swift; the vector was worked out with Python's
  // hashlib and hmac, so all three agree with something none of them wrote.
  it('matches an independently computed vector', () => {
    const hash = createHash('sha256').update('gethome-test-token', 'utf8').digest('hex');
    expect(hash).toBe('49f5e65d6023e88bbb3d6e7fada35becc0efe17d937f8380661cf6dc45daf107');
    expect(proofTokenId(hash)).toBe('11d6c74ffd9b83017557c64237106387a23a5f0eadd483f831696f8822f43c30');
    expect(proveIdentity(hash, 'hub-1', '00112233445566778899aabbccddeeff', '192.168.1.60:8420')).toBe(
      '034c81662f964982f02d5db91a712bdf33b4ddad2cf0561322af4c10b5787b6f',
    );
    expect(proofMessage('hub-1', 'ab', '10.0.0.2:8420')).toBe('gethome-hub-proof\nhub-1\nab\n10.0.0.2:8420');
  });

  it('takes only an IPv4 address and a port', () => {
    expect(proofAddressHost('192.168.1.60:8420')).toBe('192.168.1.60');
    expect(proofAddressHost('192.168.1.60')).toBeUndefined();
    expect(proofAddressHost('pi.local:8420')).toBeUndefined();
    expect(proofAddressHost('[fe80::1]:8420')).toBeUndefined();
    expect(proofAddressHost('192.168.1.256:8420')).toBeUndefined();
    expect(proofAddressHost('192.168.1.60:0')).toBeUndefined();
    expect(proofAddressHost('192.168.1.60:70000')).toBeUndefined();
  });
});

describe.skipIf(!handle)('POST /hub/proof', () => {
  const db = handle?.db!;
  let app: FastifyInstance;
  let dataDir: string;
  let token: string;
  const hubId = 'hub-proof-test';
  const here = '192.168.1.60:8420';

  beforeAll(async () => {
    await resetDb(db);
    dataDir = mkdtempSync(path.join(tmpdir(), 'gethome-proof-'));
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
      hubId,
      home: await bootedHome(db, 'Proof Hub'),
      version: '0.1.0-test',
      dataDir,
      radioBudget: 'one',
      z2mDataDir: path.join(dataDir, 'zigbee2mqtt'),
      zigbeeEnvFile: path.join(dataDir, 'zigbee.env'),
      mqtt: testBroker(),
      permitJoin: new PermitJoinService(undefined, log, () => {}),
      aiRuns: new AiRunLog(db, events),
      mappings: new MappingLibrary({ db, settings, registry, log }),
      ownAddresses: () => ['127.0.0.1', '192.168.1.60'],
    });
    const code = readFileSync(path.join(dataDir, 'pairing-code'), 'utf8').trim();
    const claimed = await app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      payload: { code, memberName: 'Georgy', deviceName: 'MacBook' },
    });
    token = (claimed.json() as { token: string }).token;
  });

  afterAll(async () => {
    await app.close();
    await handle?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const ask = (payload: object) => app.inject({ method: 'POST', url: '/api/v1/hub/proof', payload });

  it('proves itself to a token holder, with no token sent', async () => {
    const nonce = randomBytes(32).toString('hex');
    const { tokenId, expected } = asAnApp(token, hubId, nonce, here);
    const response = await ask({ nonce, address: here, tokenId });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ hubId, proof: expected });
  });

  it('signs only for an address it has, so a relayed challenge is refused', async () => {
    // An impostor at .99 hands the app's challenge to the real hub: the
    // address in it is the impostor's, and the real hub will not sign for it.
    const nonce = randomBytes(32).toString('hex');
    const { tokenId } = asAnApp(token, hubId, nonce, '192.168.1.99:8420');
    const response = await ask({ nonce, address: '192.168.1.99:8420', tokenId });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'proof_refused' });
  });

  it('answers a rewritten address with a proof the app will not accept', async () => {
    // The impostor rewrites the address to the real hub's: the hub signs, but
    // over an address the app never dialled.
    const nonce = randomBytes(32).toString('hex');
    const app99 = asAnApp(token, hubId, nonce, '192.168.1.99:8420');
    const response = await ask({ nonce, address: here, tokenId: app99.tokenId });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { proof: string }).proof).not.toBe(app99.expected);
  });

  it('refuses a token it does not hold with the same answer', async () => {
    const nonce = randomBytes(32).toString('hex');
    const { tokenId } = asAnApp('not-a-token-of-this-hub', hubId, nonce, here);
    const response = await ask({ nonce, address: here, tokenId });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'proof_refused' });
  });

  it('refuses a name, a missing port and a malformed request', async () => {
    const nonce = randomBytes(32).toString('hex');
    const { tokenId } = asAnApp(token, hubId, nonce, here);
    expect((await ask({ nonce, address: 'pi.local:8420', tokenId })).statusCode).toBe(403);
    expect((await ask({ nonce, address: '192.168.1.60', tokenId })).statusCode).toBe(403);
    expect((await ask({ nonce: 'short', address: here, tokenId })).statusCode).toBe(400);
    expect((await ask({ nonce, address: here, tokenId: 'nope' })).statusCode).toBe(400);
  });
});
