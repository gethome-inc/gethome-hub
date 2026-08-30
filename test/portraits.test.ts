import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { MAX_PER_DEVICE, PortraitService } from '../src/portraits/store.js';
import type { AdapterBus, ProtocolAdapter } from '../src/adapters/adapter.js';
import {
  bootedHome,
  loadedAccess,
  loadedFavorites,
  openTestDb,
  resetDb,
  startedHistory,
  mcpTokenService,
  testBroker,
} from './helpers/db.js';

/**
 * Device portraits, end to end minus the network.
 *
 * The image call is mocked rather than threaded through the signature — the
 * same shape `test/ai-agent.test.ts` uses for the Anthropic SDK, and for the
 * same reason: what is worth pinning is the hub's own behaviour around the
 * call, not the call.
 */
const { drawMock } = vi.hoisted(() => ({ drawMock: vi.fn() }));
vi.mock('../src/portraits/openai-images.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/portraits/openai-images.js')>();
  return { ...actual, drawPortrait: drawMock };
});

const handle = await openTestDb();
const log = pino({ level: 'silent' });

afterAll(async () => {
  await handle?.close();
});

describe.skipIf(!handle)('device portraits', () => {
  const db = handle?.db!;
  let app: FastifyInstance;
  let events: HubEventBus;
  let settings: SettingsService;
  let portraits: PortraitService;
  let dataDir: string;
  let deviceId: string;
  let adapter: FakeAdapter;
  let registry: DeviceRegistry;
  let ownerToken: string;
  let memberToken: string;
  let guestToken: string;

  /** A PNG-shaped buffer; nothing here decodes it, and the hub never does either. */
  const png = (size = 2048) => Buffer.alloc(size, 7);

  class FakeAdapter implements ProtocolAdapter {
    readonly id = 'zigbee' as const;
    bus?: AdapterBus;
    async start(bus: AdapterBus): Promise<void> {
      this.bus = bus;
    }
    async stop(): Promise<void> {}
    async execute(): Promise<void> {}
  }

  beforeEach(async () => {
    drawMock.mockReset();
    drawMock.mockResolvedValue(png());
    await resetDb(db);
    dataDir = mkdtempSync(path.join(tmpdir(), 'gethome-portraits-'));
    events = new HubEventBus();
    const access = await loadedAccess(db, events);
    const activity = new ActivityService(db, events);
    const pairing = new PairingService(db, dataDir, log, access);
    await pairing.boot();
    registry = new DeviceRegistry(db, events, activity, log);
    adapter = new FakeAdapter();
    registry.registerAdapter(adapter);
    await registry.start();
    settings = new SettingsService(db, Buffer.alloc(32).toString('base64'));
    portraits = new PortraitService(db, events, dataDir, log);
    app = await buildServer({
      db,
      log,
      events,
      registry,
      favorites: await loadedFavorites(db, events),
      access,
      pairing,
      activity,
      history: await startedHistory(db, events),
      portraits,
      settings,
      aiRuns: new AiRunLog(db, events),
      mappings: new MappingLibrary({ db, settings, registry, log }),
      hubId: 'hub-portraits',
      home: await bootedHome(db, 'Portrait Hub'),
      version: '0.1.0-test',
      dataDir,
      radioBudget: 'both',
      z2mDataDir: path.join(dataDir, 'zigbee2mqtt'),
      mqtt: testBroker(),
      mcpTokens: mcpTokenService(db),
      permitJoin: new PermitJoinService(undefined, log, () => {}),
    });
    await app.ready();

    const code = readFileSync(path.join(dataDir, 'pairing-code'), 'utf8').trim();
    ownerToken = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/pair',
        payload: { code, memberName: 'Georgy', deviceName: 'MacBook' },
      })
    ).json().token as string;
    memberToken = await join('Anna', 'member');
    guestToken = await join('Sam', 'guest');

    adapter.bus!.deviceUpserted({
      adapter: 'zigbee',
      externalId: '0x00124b0022334455',
      suggestedName: 'Kitchen lamp',
      endpoints: [{ endpointId: 1, deviceKind: 'light', capabilities: ['onOff'], primary: 'onOff' }],
    });
    await registry.flush();
    deviceId = registry.listDevices()[0]!.id;
  });

  /** An invite, then a pair — the only way somebody who is not the owner gets in. */
  async function join(name: string, roleKey: string): Promise<string> {
    const roles = (
      await app.inject({ method: 'GET', url: '/api/v1/roles', headers: auth(ownerToken) })
    ).json() as Array<{ id: string; key: string }>;
    const invite = await app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: auth(ownerToken),
      payload: { roleId: roles.find((role) => role.key === roleKey)!.id },
    });
    const { code } = invite.json() as { code: string };
    const joined = await app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      payload: { code, memberName: name },
    });
    return (joined.json() as { token: string }).token;
  }

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  const draw = (token = memberToken, payload: object = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/devices/${deviceId}/portraits`,
      headers: auth(token),
      payload,
    });

  // ── The credential ────────────────────────────────────────────────────────

  /**
   * Its own refusal code. Portraits are drawn by OpenAI while device
   * recognition may be running on Anthropic, so `ai_not_configured` would be
   * wrong about a hub that is perfectly configured — for the other job.
   */
  it('refuses to draw without an OpenAI key, and says which key is missing', async () => {
    await settings.setAiKey('anthropic', 'sk-ant-api-1234567890');
    const refused = await draw();
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'openai_not_configured' });
    expect(drawMock).not.toHaveBeenCalled();
  });

  /**
   * `ai_enabled` is the *adaptation* switch: it exists because the agent runs
   * by itself when a device turns up. Nobody draws a portrait by accident, so
   * there is nothing for that switch to protect here.
   */
  it('draws while adaptation is switched off', async () => {
    await settings.setAiKey('openai', 'sk-proj-1234567890');
    await settings.setAiEnabled(false);
    expect((await draw()).statusCode).toBe(200);
  });

  // ── Drawing ───────────────────────────────────────────────────────────────

  it('stores the picture, selects it, and announces it to every socket', async () => {
    await settings.setAiKey('openai', 'sk-proj-1234567890');
    const announced: string[] = [];
    events.on('portraitsChanged', (id) => announced.push(id));

    const created = await draw();
    expect(created.statusCode).toBe(200);
    const portrait = created.json() as { id: string; selected: boolean; fromPhoto: boolean };
    expect(portrait).toMatchObject({ selected: true, fromPhoto: false, provider: 'openai' });
    expect(announced).toEqual([deviceId]);
    expect(existsSync(path.join(dataDir, 'portraits', deviceId, `${portrait.id}.png`))).toBe(true);

    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/devices/${deviceId}/portraits`,
      headers: auth(guestToken),
    });
    expect(listed.json()).toHaveLength(1);
  });

  it('takes a photo as the reference and says the picture came from one', async () => {
    await settings.setAiKey('openai', 'sk-proj-1234567890');
    const created = await draw(memberToken, { photo: Buffer.alloc(128, 3).toString('base64') });
    expect(created.json()).toMatchObject({ fromPhoto: true });
    expect(drawMock.mock.calls[0]?.[0]).toMatchObject({ photo: { contentType: 'image/jpeg' } });
    // The photo path deliberately never names the device kind: the object in
    // front of the camera may be anything the outlet feeds.
    expect(drawMock.mock.calls[0]?.[0].prompt).not.toContain('smart wall plug');
  });

  it('records one line of the home’s history per drawing, and none for a restyle', async () => {
    await settings.setAiKey('openai', 'sk-proj-1234567890');
    const created = (await draw()).json() as { id: string };
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/devices/${deviceId}/portraits`,
      headers: auth(memberToken),
      payload: { selected: null },
    });

    const feed = (
      await app.inject({ method: 'GET', url: '/api/v1/activity', headers: auth(ownerToken) })
    ).json() as Array<{ kind: string; message: string }>;
    const mine = feed.filter((entry) => entry.kind === 'device.portrait');
    expect(mine).toHaveLength(1);
    expect(mine[0]?.message).toContain('Kitchen lamp');
    expect(created.id).toBeTruthy();
  });

  it('relays the provider’s own sentence when a drawing fails', async () => {
    await settings.setAiKey('openai', 'sk-proj-1234567890');
    const { PortraitDrawError } = await import('../src/portraits/openai-images.js');
    drawMock.mockRejectedValueOnce(new PortraitDrawError('Your account has no credit.', 'billing'));
    const failed = await draw();
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({
      error: 'provider_failed',
      kind: 'billing',
      detail: 'Your account has no credit.',
    });
  });

  // ── The bytes ─────────────────────────────────────────────────────────────

  it('serves the PNG once and then answers 304', async () => {
    await settings.setAiKey('openai', 'sk-proj-1234567890');
    const { id } = (await draw()).json() as { id: string };

    const image = await app.inject({
      method: 'GET',
      url: `/api/v1/portraits/${id}`,
      headers: auth(guestToken),
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.headers['cache-control']).toContain('immutable');
    expect(image.rawPayload.byteLength).toBe(2048);

    const again = await app.inject({
      method: 'GET',
      url: `/api/v1/portraits/${id}`,
      headers: { ...auth(guestToken), 'if-none-match': String(image.headers.etag) },
    });
    expect(again.statusCode).toBe(304);
  });

  // ── Choosing, deleting, and what a role may do ────────────────────────────

  /**
   * `null` is a state rather than an absence: it means the home chose the
   * procedural sphere over every picture it has, which is why selecting is a
   * nullable field and not a delete.
   */
  it('lets a member pick the sphere without losing the portraits', async () => {
    await settings.setAiKey('openai', 'sk-proj-1234567890');
    await draw();
    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/v1/devices/${deviceId}/portraits`,
      headers: auth(memberToken),
      payload: { selected: null },
    });
    expect(cleared.statusCode).toBe(200);
    const list = cleared.json() as Array<{ selected: boolean }>;
    expect(list).toHaveLength(1);
    expect(list[0]?.selected).toBe(false);
  });

  it('refuses a guest the drawing, the choosing and the deleting — but never the looking', async () => {
    await settings.setAiKey('openai', 'sk-proj-1234567890');
    const { id } = (await draw()).json() as { id: string };

    expect((await draw(guestToken)).statusCode).toBe(403);
    const chosen = await app.inject({
      method: 'PATCH',
      url: `/api/v1/devices/${deviceId}/portraits`,
      headers: auth(guestToken),
      payload: { selected: id },
    });
    expect(chosen.statusCode).toBe(403);
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/portraits/${id}`,
      headers: auth(guestToken),
    });
    expect(removed.statusCode).toBe(403);

    const seen = await app.inject({
      method: 'GET',
      url: `/api/v1/portraits/${id}`,
      headers: auth(guestToken),
    });
    expect(seen.statusCode).toBe(200);
  });

  it('deletes the file with the row', async () => {
    await settings.setAiKey('openai', 'sk-proj-1234567890');
    const { id } = (await draw()).json() as { id: string };
    const file = path.join(dataDir, 'portraits', deviceId, `${id}.png`);
    expect(existsSync(file)).toBe(true);

    expect(
      (await app.inject({ method: 'DELETE', url: `/api/v1/portraits/${id}`, headers: auth(memberToken) }))
        .statusCode,
    ).toBe(204);
    expect(existsSync(file)).toBe(false);
    expect(await portraits.list(deviceId)).toHaveLength(0);
  });

  /**
   * `selected: null` means somebody *chose* the sphere over every picture they
   * have. Deleting the one on screen is not that choice, so the newest
   * remaining takes its place rather than leaving the device looking like a
   * home that had opted out.
   */
  it('hands the slot to the newest remaining when the one on screen is deleted', async () => {
    await settings.setAiKey('openai', 'sk-proj-1234567890');
    const older = (await draw()).json() as { id: string };
    const newer = (await draw()).json() as { id: string };
    expect((await portraits.list(deviceId)).find((row) => row.selected)?.id).toBe(newer.id);

    expect(
      (await app.inject({ method: 'DELETE', url: `/api/v1/portraits/${newer.id}`, headers: auth(memberToken) }))
        .statusCode,
    ).toBe(204);

    const left = await portraits.list(deviceId);
    expect(left.map((row) => row.id)).toEqual([older.id]);
    expect(left[0]?.selected).toBe(true);
  });

  /**
   * One drawing at a time, hub-wide, and a second asker is refused rather than
   * queued — `docs/api.md` and `docs/portraits.md` both promise the code, and
   * an app that cannot tell "busy" from "broken" says the wrong thing. Queueing
   * would hold a synchronous request open for however long the ones in front
   * of it take, which on a Zero 2 W is minutes.
   */
  it('refuses a second drawing while one is in flight, rather than queueing it', async () => {
    await settings.setAiKey('openai', 'sk-proj-1234567890');
    let release: (() => void) | undefined;
    drawMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(png());
        }),
    );

    const first = draw();
    // Let the route reach the image call before the second one asks.
    for (let i = 0; i < 50 && !release; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const second = await draw();
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: 'portrait_busy' });

    release?.();
    expect((await first).statusCode).toBe(200);
    // And the flag is released, so the next one is not refused for ever.
    expect((await draw()).statusCode).toBe(200);
  });

  // ── Bounds ────────────────────────────────────────────────────────────────

  /**
   * The per-device bound. Drawing takes the selection, so the newest is always
   * the one on screen and the oldest is what goes.
   */
  it('keeps the newest few per device', async () => {
    await settings.setAiKey('openai', 'sk-proj-1234567890');
    const drawn: string[] = [];
    for (let i = 0; i < MAX_PER_DEVICE + 2; i += 1) {
      drawn.push(((await draw()).json() as { id: string }).id);
    }
    const list = await portraits.list(deviceId);
    expect(list).toHaveLength(MAX_PER_DEVICE);
    // Newest first, and the last one drawn is the one the home is looking at.
    expect(list[0]?.id).toBe(drawn.at(-1));
    expect(list[0]?.selected).toBe(true);
    expect(list.some((portrait) => portrait.id === drawn[0])).toBe(false);
  });

  /**
   * The disk bound, and the rule that makes it safe to have: one device's new
   * portrait must never evict the picture *another* device is showing. Run
   * against a tiny budget rather than three hundred real megabytes.
   */
  it('sweeps the oldest to stay inside its disk budget, and skips what is on screen', async () => {
    await settings.setAiKey('openai', 'sk-proj-1234567890');
    const tight = new PortraitService(db, events, dataDir, log, { budgetBytes: 5000 });
    const kind = 'light' as const;
    const first = await tight.draw({ deviceId, kind, apiKey: 'sk-proj-x' });
    const second = await tight.draw({ deviceId, kind, apiKey: 'sk-proj-x' });
    // Two 2 KB pictures fit; a third does not, and the oldest unpinned goes.
    await tight.draw({ deviceId, kind, apiKey: 'sk-proj-x' });

    const list = await tight.list(deviceId);
    expect(list.some((portrait) => portrait.id === first.id)).toBe(false);
    expect(list.some((portrait) => portrait.id === second.id)).toBe(true);
    // Whatever it dropped, it never dropped the one the home is looking at.
    expect(list.filter((portrait) => portrait.selected)).toHaveLength(1);
    expect(existsSync(path.join(dataDir, 'portraits', deviceId, `${first.id}.png`))).toBe(false);
  });

  /**
   * The rows go with the device by cascade, which is precisely why the files
   * need wiring — nothing else would ever hear about the delete.
   */
  it('takes a removed device’s files with it', async () => {
    await settings.setAiKey('openai', 'sk-proj-1234567890');
    await draw();
    const dir = path.join(dataDir, 'portraits', deviceId);
    expect(existsSync(dir)).toBe(true);

    await app.inject({ method: 'DELETE', url: `/api/v1/devices/${deviceId}`, headers: auth(ownerToken) });
    // The sweep is hung off the bus event, so it lands a turn or two later.
    for (let i = 0; i < 50 && existsSync(dir); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(dir)).toBe(false);
  });
});
