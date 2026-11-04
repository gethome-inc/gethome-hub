import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { eq } from 'drizzle-orm';
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
import { RETAIN_TRANSCRIPT_DAYS, type AgentConversation } from '../src/ai/chat/chat-runtime.js';
import type { AssistantTurn } from '../src/ai/assistant-agent.js';
import type { AutomationConversation } from '../src/ai/automation-conversation.js';
import type { AssistantChat } from '../src/ai/assistant-chat.js';
import type { AutomationChat } from '../src/ai/automation-chat.js';
import type { AutomationEngine } from '../src/automations/engine.js';
import { PortraitService } from '../src/portraits/store.js';
import { RoomPictureService } from '../src/room-pictures/store.js';
import { CHAT_PHOTO_RETAIN_DAYS, PHOTOS_MIN_FREE_BYTES, PhotoStore } from '../src/photos/store.js';
import { activity as activityTable, aiRuns, automationChatMessages, devices, members } from '../src/db/schema.js';
import type { AdapterBus, ProtocolAdapter } from '../src/adapters/adapter.js';
import {
  bootedHome,
  loadedAccess,
  loadedFavorites,
  openTestDb,
  resetDb,
  startedAutomations,
  startedHistory,
  testBroker,
} from './helpers/db.js';

/**
 * The photos a home, or one person, chose to keep — `src/photos/store.ts`.
 *
 * Four promises are what this suite is for. **Nothing is kept unless it was
 * asked for twice** — by the request, and by the switch for its kind. **A photo
 * lives exactly as long as what it was kept for.** **A full disk pauses keeping
 * and deletes nothing.** And **a chat photo is its sender's alone.**
 */

const { drawMock } = vi.hoisted(() => ({ drawMock: vi.fn() }));
vi.mock('../src/portraits/openai-images.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/portraits/openai-images.js')>();
  return { ...actual, drawPortrait: drawMock };
});

const handle = await openTestDb();
const log = pino({ level: 'silent' });
const DAY = 24 * 60 * 60_000;
const UUID = /^[0-9a-f-]{36}$/;

/** Bytes that cannot occur by accident anywhere else. */
const bytes = (size = 256) => randomBytes(size);
const jpeg = (size = 256) => ({ bytes: bytes(size), mediaType: 'image/jpeg' });

// ── The store on its own ─────────────────────────────────────────────────────

describe.skipIf(!handle)('the photo store', () => {
  const db = handle?.db!;
  let dir: string;
  let free: number;
  let now: number;
  let store: PhotoStore;
  let annaId: string;
  let heard: (string | null)[];

  const anna = () => ({ id: annaId, name: 'Anna' });
  const files = () => readdirSync(path.join(dir, 'photos')).sort();

  beforeEach(async () => {
    await resetDb(db);
    dir = mkdtempSync(path.join(tmpdir(), 'gethome-photos-'));
    free = 10_000;
    now = Date.parse('2026-11-02T12:00:00Z');
    heard = [];
    const events = new HubEventBus();
    events.on('photosChanged', (memberId) => heard.push(memberId));
    const settings = new SettingsService(db, Buffer.alloc(32).toString('base64'));
    store = new PhotoStore(
      db,
      settings,
      dir,
      events,
      undefined,
      { minFreeBytes: 2_000, resumeFreeBytes: 2_500, chatBudgetBytes: 300, chatRetainDays: 14 },
      async () => ({ totalBytes: 50_000, freeBytes: free }),
      () => now,
    );
    const [row] = await db.insert(members).values({ name: 'Anna', role: 'member' }).returning();
    annaId = row!.id;
  });

  it('keeps nothing until its own switch is on, and says so', async () => {
    const off = await store.keep({ kind: 'room', subjectId: 'room-1', member: anna(), photos: [jpeg()], useId: 'pic-1' });
    expect(off).toEqual({ ids: [null], outcome: { kept: 0, reason: 'off' } });
    const chat = await store.keep({ kind: 'chat', subjectId: annaId, member: { id: annaId }, photos: [jpeg()] });
    expect(chat.outcome).toEqual({ kept: 0, reason: 'off' });
    expect(heard).toEqual([]);

    await store.setHome({ room: true });
    const photo = jpeg();
    const on = await store.keep({ kind: 'room', subjectId: 'room-1', member: anna(), photos: [photo], useId: 'pic-1' });
    expect(on.outcome).toEqual({ kept: 1 });
    expect(on.ids[0]).toMatch(UUID);
    const read = await store.read(on.ids[0]!);
    expect(read?.bytes.equals(photo.bytes)).toBe(true);
    expect(read?.record).toMatchObject({ kind: 'room', subjectId: 'room-1', takenBy: { id: annaId, name: 'Anna' } });
    expect(heard).toContain(null);

    // The portraits' switch is its own, and still off.
    const portrait = await store.keep({ kind: 'portrait', subjectId: 'dev-1', member: anna(), photos: [jpeg()], useId: 'p-1' });
    expect(portrait.outcome).toEqual({ kept: 0, reason: 'off' });
  });

  it('lets a photo go with the last thing it was kept for, file and all', async () => {
    await store.setHome({ room: true });
    const { ids } = await store.keep({
      kind: 'room',
      subjectId: 'room-1',
      member: anna(),
      photos: [jpeg(), jpeg()],
      useId: 'pic-1',
    });
    const [first, second] = ids as [string, string];
    // The room drawn again from the first photo.
    await store.attach([first], 'pic-2');
    expect(files()).toHaveLength(2);

    expect(await store.release('pic-1')).toBe(1);
    expect(await store.get(first)).not.toBeNull();
    expect(await store.get(second)).toBeNull();
    expect(files()).toHaveLength(1);

    expect(await store.release('pic-2')).toBe(1);
    expect(await store.get(first)).toBeNull();
    expect(files()).toEqual([]);
    // Releasing what holds nothing is nothing.
    expect(await store.release('pic-3')).toBe(0);
  });

  it('attaches the copy already kept when the same photo comes again for the same room or device', async () => {
    await store.setHome({ room: true });
    const photo = jpeg();
    const first = await store.keep({ kind: 'room', subjectId: 'room-1', member: anna(), photos: [photo, jpeg()], useId: 'pic-1' });
    // The room drawn again from the photos the phone that took them still
    // has: the same bytes, sent again, beside one new photo.
    const again = await store.keep({
      kind: 'room',
      subjectId: 'room-1',
      member: anna(),
      photos: [{ ...photo, bytes: Buffer.from(photo.bytes) }, jpeg()],
      useId: 'pic-2',
    });
    expect(again.outcome).toEqual({ kept: 2 });
    expect(again.ids[0]).toBe(first.ids[0]);
    expect(again.ids[1]).not.toBe(first.ids[1]);
    expect(files()).toHaveLength(3);
    // Kept for both drawings now, so the first one going leaves it.
    await store.release('pic-1');
    expect(await store.get(first.ids[0]!)).not.toBeNull();
    await store.release('pic-2');
    expect(await store.get(first.ids[0]!)).toBeNull();

    // Another room's photo of the same bytes is that room's own.
    const there = await store.keep({ kind: 'room', subjectId: 'room-2', member: anna(), photos: [photo], useId: 'pic-3' });
    const here = await store.keep({ kind: 'room', subjectId: 'room-1', member: anna(), photos: [photo], useId: 'pic-4' });
    expect(there.ids[0]).not.toBe(here.ids[0]);

    // And a chat photo is never compared: each is its sender's, for one message.
    await store.setMine(annaId, true);
    const sent = jpeg(50);
    const once = await store.keep({ kind: 'chat', subjectId: annaId, member: { id: annaId }, photos: [sent] });
    const twice = await store.keep({ kind: 'chat', subjectId: annaId, member: { id: annaId }, photos: [sent] });
    expect(once.ids[0]).toMatch(UUID);
    expect(twice.ids[0]).toMatch(UUID);
    expect(twice.ids[0]).not.toBe(once.ids[0]);
  });

  it('attaches a copy already kept while keeping is paused, and keeps nothing new', async () => {
    await store.setHome({ room: true });
    const photo = jpeg(100);
    const first = await store.keep({ kind: 'room', subjectId: 'room-1', member: anna(), photos: [photo], useId: 'pic-1' });
    now += 60_000;
    free = 1_000;
    const again = await store.keep({ kind: 'room', subjectId: 'room-1', member: anna(), photos: [photo, jpeg(100)], useId: 'pic-2' });
    expect(again.ids).toEqual([first.ids[0], null]);
    expect(again.outcome).toEqual({ kept: 1, reason: 'low-space' });
    await store.release('pic-1');
    expect(await store.get(first.ids[0]!)).not.toBeNull();
    // Nothing that is all new is attached to anything.
    expect((await store.keep({ kind: 'room', subjectId: 'room-1', member: anna(), photos: [jpeg(100)], useId: 'pic-3' })).outcome).toEqual({
      kept: 0,
      reason: 'low-space',
    });
  });

  it('pauses below the floor, starts again only past the second bound, and deletes nothing', async () => {
    await store.setHome({ room: true });
    const keep = () => store.keep({ kind: 'room', subjectId: 'room-1', member: anna(), photos: [jpeg(100)], useId: 'pic' });
    const kept = await keep();
    expect(kept.outcome).toEqual({ kept: 1 });

    now += 60_000;
    free = 1_999;
    expect((await keep()).outcome).toEqual({ kept: 0, reason: 'low-space' });
    expect(await store.state(annaId)).toMatchObject({ paused: true, reason: 'low-space', space: { freeBytes: 1_999 } });
    // What was kept before stays kept.
    expect(await store.get(kept.ids[0]!)).not.toBeNull();

    // Above the floor but short of the second bound: still paused, so a hub
    // sitting on the line does not flap between keeping and not.
    now += 60_000;
    free = 2_400;
    expect((await keep()).outcome).toEqual({ kept: 0, reason: 'low-space' });

    now += 60_000;
    free = 2_600;
    expect((await keep()).outcome).toEqual({ kept: 1 });
    expect(await store.state(annaId)).toMatchObject({ paused: false });
    expect(await store.state(annaId)).not.toHaveProperty('reason');

    // A photo that would itself cross the floor is refused without pausing.
    now += 60_000;
    free = 2_050;
    expect((await keep()).outcome).toEqual({ kept: 0, reason: 'low-space' });
    expect(await store.state(annaId)).toMatchObject({ paused: false });
  });

  it('keeps a chat photo only for a sender who chose to, inside the budget, for the fortnight', async () => {
    await store.setMine(annaId, true);
    expect(heard).toEqual([annaId]);
    const keepChat = async (size: number, message: string) => {
      const { ids } = await store.keep({ kind: 'chat', subjectId: annaId, member: { id: annaId }, photos: [jpeg(size)] });
      await store.attach([ids[0]!], message);
      return ids[0]!;
    };
    const start = now;
    const first = await keepChat(100, 'msg-1');
    now = start + DAY;
    const second = await keepChat(100, 'msg-2');
    now = start + 2 * DAY;
    // 350 bytes against a budget of 300: the oldest goes to make room.
    const third = await keepChat(150, 'msg-3');
    expect(await store.get(first)).toBeNull();
    expect(await store.get(second)).not.toBeNull();
    expect(await store.get(third)).not.toBeNull();

    // A fortnight and a half after the first: the second is past its fortnight.
    now = start + 15.5 * DAY;
    expect(await store.sweep()).toBe(1);
    expect(await store.get(second)).toBeNull();
    expect(await store.get(third)).not.toBeNull();
    expect((await store.state(annaId)).mine.chat).toMatchObject({ keep: true, count: 1, bytes: 150 });
  });

  it('sweeps a photo that never found a use, but only once it has had an hour to', async () => {
    await store.setHome({ portrait: true });
    const { ids } = await store.keep({ kind: 'portrait', subjectId: 'dev-1', member: anna(), photos: [jpeg()] });
    expect(await store.sweep()).toBe(0);
    now += 2 * 60 * 60_000;
    expect(await store.sweep()).toBe(1);
    expect(await store.get(ids[0]!)).toBeNull();
  });

  it('takes a member’s chat photos with them, and leaves the room photos they took with their name', async () => {
    await store.setHome({ room: true });
    await store.setMine(annaId, true);
    const room = await store.keep({ kind: 'room', subjectId: 'room-1', member: anna(), photos: [jpeg()], useId: 'pic-1' });
    const chat = await store.keep({ kind: 'chat', subjectId: annaId, member: { id: annaId }, photos: [jpeg()], useId: 'msg-1' });

    // The route deletes the member's row first; the foreign key nulls the id.
    await db.delete(members).where(eq(members.id, annaId));
    expect(await store.forgetMember(annaId)).toBe(1);
    expect(await store.get(chat.ids[0]!)).toBeNull();
    expect((await store.get(room.ids[0]!))?.takenBy).toEqual({ id: null, name: 'Anna' });
  });

  it('puts the store and the disk back in agreement at boot', async () => {
    await store.setHome({ room: true, portrait: true });
    await store.setMine(annaId, true);
    const live = (await store.keep({ kind: 'room', subjectId: 'room-1', member: anna(), photos: [jpeg()], useId: 'pic-live' })).ids[0]!;
    // A drawing an older build deleted after a rollback, without a word to us.
    const orphaned = (await store.keep({ kind: 'room', subjectId: 'room-1', member: anna(), photos: [jpeg()], useId: 'pic-gone' })).ids[0]!;
    // A portrait and a message that no longer exist.
    const portrait = (await store.keep({ kind: 'portrait', subjectId: 'dev-1', member: anna(), photos: [jpeg()], useId: 'no-such-portrait' })).ids[0]!;
    const chat = (await store.keep({ kind: 'chat', subjectId: annaId, member: { id: annaId }, photos: [jpeg()], useId: 'no-such-message' })).ids[0]!;
    // A row whose file somebody tidied away.
    const fileless = (await store.keep({ kind: 'room', subjectId: 'room-1', member: anna(), photos: [jpeg()], useId: 'pic-live' })).ids[0]!;
    rmSync(path.join(dir, 'photos', `${fileless}.jpg`));
    // A file with no row, and a write cut short.
    writeFileSync(path.join(dir, 'photos', 'stray.jpg'), 'x');
    writeFileSync(path.join(dir, 'photos', `${live}.jpg.tmp`), 'x');

    await store.reconcile({ roomPictureIds: ['pic-live'] });

    expect(await store.get(live)).not.toBeNull();
    for (const gone of [orphaned, portrait, chat, fileless]) expect(await store.get(gone)).toBeNull();
    expect(files()).toEqual([`${live}.jpg`]);
  });

  it('leaves every row alone when the photos folder cannot be read', async () => {
    await store.setHome({ room: true });
    const kept = (await store.keep({ kind: 'room', subjectId: 'room-1', member: anna(), photos: [jpeg()], useId: 'pic-live' })).ids[0]!;
    // There, but not a folder that can be listed: nothing can be concluded
    // about the files, so nothing is concluded about the rows either.
    rmSync(path.join(dir, 'photos'), { recursive: true, force: true });
    writeFileSync(path.join(dir, 'photos'), 'not a folder');

    await store.reconcile({ roomPictureIds: ['pic-live'] });

    expect(await store.get(kept)).not.toBeNull();
  });

  it('attaches only what it still keeps, and never throws into the drawing', async () => {
    await store.setHome({ room: true });
    const kept = (await store.keep({ kind: 'room', subjectId: 'room-1', member: anna(), photos: [jpeg()], useId: 'pic-1' })).ids[0]!;
    expect(await store.attach([kept, '00000000-0000-4000-8000-000000000000'], 'pic-2')).toEqual([kept]);
    expect((await store.forUses(['pic-2'])).get('pic-2')?.map((photo) => photo.id)).toEqual([kept]);
  });

  it('keeps the photo a room is drawn again from when its only drawing is the one pruned', async () => {
    await store.setHome({ room: true });
    const draw = vi.fn(async () => ({ png: Buffer.alloc(1024, 1), usage: { inputTextTokens: 1, inputImageTokens: 1, outputTokens: 1 } }));
    const locate = vi.fn(async () => ({ located: [], usage: { input_tokens: 1, output_tokens: 1 } }));
    // One drawing a room: drawing again prunes the one the photo was kept with.
    const pictures = new RoomPictureService(
      dir,
      new HubEventBus(),
      undefined,
      undefined,
      { maxPerRoom: 1, minFreeBytes: 0 },
      draw as never,
      locate as never,
      vi.fn() as never,
      store,
    );
    const photo = { bytes: bytes(300), contentType: 'image/jpeg' };
    const room = {
      roomId: 'room-1',
      roomName: 'Kitchen',
      orientation: 'portrait' as const,
      devices: [],
      apiKey: 'sk-test',
      locator: async () => [],
      member: anna(),
    };
    const first = await pictures.draw({ ...room, photos: [photo], keepPhotos: true });
    await pictures.settled();
    const keptId = (await store.forUses([first.id])).get(first.id)![0]!.id;

    const again = await pictures.draw({ ...room, photos: [{ ...photo, keptId }], keepPhotos: true });
    await pictures.settled();

    expect(again.photosKept).toEqual({ kept: 1 });
    expect(pictures.get(first.id)).toBeUndefined();
    expect(await store.get(keptId)).not.toBeNull();
    expect((await store.forUses([again.id])).get(again.id)?.map((kept) => kept.id)).toEqual([keptId]);
  });

  it('keeps the photo a portrait is drawn again from when its only portrait is the one pruned', async () => {
    await store.setHome({ portrait: true });
    drawMock.mockResolvedValue({ png: Buffer.alloc(2048, 7), usage: { inputTextTokens: 200, inputImageTokens: 0, outputTokens: 4160 } });
    const [device] = await db.insert(devices).values({ adapter: 'zigbee', externalId: 'kettle-1', name: 'Kettle' }).returning();
    const events = new HubEventBus();
    // One portrait a device: drawing again prunes the one the photo was kept with.
    const portraits = new PortraitService(db, events, dir, log, new AiRunLog(db, events), { maxPerDevice: 1, minFreeBytes: 0 }, store);
    const photo = { bytes: bytes(300), contentType: 'image/jpeg' };
    const ask = { deviceId: device!.id, kind: 'outlet' as const, apiKey: 'sk-test', member: anna() };
    const first = await portraits.draw({ ...ask, photo, keepPhoto: true });
    const keptId = first.photo!.id;

    const again = await portraits.draw({ ...ask, photo, keptPhotoId: keptId });

    expect(again.photosKept).toEqual({ kept: 1 });
    expect(again.photo?.id).toBe(keptId);
    expect((await portraits.list(device!.id)).map((portrait) => portrait.id)).toEqual([again.id]);
    expect(await store.get(keptId)).not.toBeNull();
  });

  it('keeps a chat photo exactly as long as the transcript it belongs to', () => {
    expect(CHAT_PHOTO_RETAIN_DAYS).toBe(RETAIN_TRANSCRIPT_DAYS);
  });
});

// ── Over the API ─────────────────────────────────────────────────────────────

class FakeAdapter implements ProtocolAdapter {
  readonly id = 'zigbee' as const;
  bus?: AdapterBus;
  async start(bus: AdapterBus): Promise<void> {
    this.bus = bus;
  }
  async stop(): Promise<void> {}
  async execute(): Promise<void> {}
}

/** A conversation that answers without reaching a provider. */
function assistantStandIn({ provider, modelId }: { provider: string; modelId: string; taskPrompt: string }) {
  const round = async (): Promise<AssistantTurn> => ({ kind: 'said', text: 'Done.' });
  const conversation: AgentConversation<AssistantTurn> = {
    provider,
    modelId,
    effort: 'medium' as const,
    awaitingAnswer: () => false,
    costUsd: () => 0,
    send: round,
    answer: round,
  };
  return conversation;
}

function automationStandIn({ provider, modelId }: { provider: string; modelId: string; taskPrompt: string }) {
  const conversation: AutomationConversation = {
    provider,
    modelId,
    effort: 'medium' as const,
    awaitingAnswer: () => false,
    costUsd: () => 0,
    send: async () => ({ kind: 'said', text: 'On it.' }),
    answer: async () => ({ kind: 'said', text: 'On it.' }),
  };
  return conversation;
}

describe.skipIf(!handle)('photos over the API', () => {
  const db = handle?.db!;
  let app: FastifyInstance;
  let photos: PhotoStore;
  let pictures: RoomPictureService;
  let engine: AutomationEngine;
  let assistantChat: AssistantChat;
  let automationChat: AutomationChat;
  let dataDir: string;
  let ownerToken: string;
  let memberToken: string;
  let guestToken: string;
  let kitchenId: string;
  let hallId: string;
  let deviceId: string;

  const usage = { inputTextTokens: 275, inputImageTokens: 4480, outputTokens: 1372 };
  const drawRoom = vi.fn(async () => ({ png: Buffer.alloc(4096, 1), usage }));
  const locate = vi.fn(async () => ({ located: [], usage: { input_tokens: 10, output_tokens: 5 } }));

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  /** `object`, never `unknown`, for the payload — see `test/CLAUDE.md`. */
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token: string, payload?: object) =>
    app.inject({ method, url, headers: auth(token), ...(payload !== undefined ? { payload } : {}) });

  const join = async (name: string, key: string): Promise<string> => {
    const roles = (await call('GET', '/api/v1/roles', ownerToken)).json() as { id: string; key: string }[];
    const invite = await call('POST', '/api/v1/invites', ownerToken, { roleId: roles.find((role) => role.key === key)!.id });
    const { code } = invite.json() as { code: string };
    const joined = await app.inject({ method: 'POST', url: '/api/v1/pair', payload: { code, memberName: name } });
    return (joined.json() as { token: string }).token;
  };

  beforeAll(async () => {
    await resetDb(db);
    dataDir = mkdtempSync(path.join(tmpdir(), 'gethome-photos-api-'));
    const events = new HubEventBus();
    const access = await loadedAccess(db, events);
    const activity = new ActivityService(db, events);
    const pairing = new PairingService(db, dataDir, log, access);
    await pairing.boot();
    const registry = new DeviceRegistry(db, events, activity, log);
    const adapter = new FakeAdapter();
    registry.registerAdapter(adapter);
    await registry.start();
    const settings = new SettingsService(db, Buffer.alloc(32).toString('base64'));
    await settings.setAiKey('anthropic', 'sk-ant-api03-test');
    await settings.setAiKey('openai', 'sk-proj-test');
    const runs = new AiRunLog(db, events);
    photos = new PhotoStore(db, settings, dataDir, events, log, {}, async () => ({
      totalBytes: 32 * 1024 ** 3,
      freeBytes: 20 * 1024 ** 3,
    }));
    const portraits = new PortraitService(db, events, dataDir, log, runs, {}, photos);
    pictures = new RoomPictureService(dataDir, events, undefined, runs, {}, drawRoom as never, locate as never, vi.fn(), photos);
    const started = await startedAutomations(db, events, registry, activity, {
      settings,
      access,
      runs,
      createConversation: automationStandIn,
      createAssistantConversation: assistantStandIn,
      keptPhotos: photos,
    });
    engine = started.engine;
    assistantChat = started.assistant;
    automationChat = started.chat;
    app = await buildServer({
      db,
      log,
      events,
      registry,
      favorites: await loadedFavorites(db, events),
      access,
      pairing,
      activity,
      automations: engine,
      automationStore: started.store,
      automationChat,
      assistantChat,
      history: await startedHistory(db, events),
      portraits,
      photos,
      roomPictures: pictures,
      settings,
      home: await bootedHome(db, 'Photo Hub'),
      hubId: 'hub-photos-test',
      version: '0.1.0-test',
      dataDir,
      radioBudget: 'one',
      z2mDataDir: path.join(dataDir, 'zigbee2mqtt'),
      zigbeeEnvFile: path.join(dataDir, 'zigbee.env'),
      mqtt: testBroker(),
      permitJoin: new PermitJoinService(undefined, log, () => {}),
      aiRuns: runs,
      mappings: new MappingLibrary({ db, settings, registry, log }),
    });

    const code = readFileSync(path.join(dataDir, 'pairing-code'), 'utf8').trim();
    const claimed = await app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      payload: { code, memberName: 'Georgy', deviceName: 'MacBook' },
    });
    ownerToken = (claimed.json() as { token: string }).token;
    memberToken = await join('Anna', 'member');
    guestToken = await join('Kolya', 'guest');

    kitchenId = (await call('POST', '/api/v1/rooms', ownerToken, { name: 'Kitchen' })).json().id as string;
    hallId = (await call('POST', '/api/v1/rooms', ownerToken, { name: 'Hall' })).json().id as string;
    adapter.bus!.deviceUpserted({
      adapter: 'zigbee',
      externalId: 'kettle-1',
      suggestedName: 'Kettle',
      endpoints: [{ endpointId: 1, deviceKind: 'outlet', capabilities: ['onOff'], primary: 'onOff' }],
    });
    await registry.flush();
    deviceId = registry.listDevices()[0]!.id;
  });

  afterAll(async () => {
    await engine?.stop();
    await app?.close();
  });

  const idle = async () => {
    await assistantChat.idle();
    await automationChat.idle();
  };

  it('says on GET /hub that it can keep photos, and nothing about what it keeps', async () => {
    const hub = (await app.inject({ method: 'GET', url: '/api/v1/hub' })).json() as { photos?: unknown };
    expect(hub.photos).toEqual({
      kinds: ['room', 'portrait', 'chat'],
      minFreeBytes: PHOTOS_MIN_FREE_BYTES,
      chatRetainDays: 14,
    });
  });

  it('answers what is kept, and lets whoever draws turn the home’s switches, with a line in the log', async () => {
    const before = await call('GET', '/api/v1/photos', memberToken);
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({
      paused: false,
      space: { totalBytes: 32 * 1024 ** 3, freeBytes: 20 * 1024 ** 3 },
      home: { room: { keep: false, count: 0 }, portrait: { keep: false, count: 0 } },
      mine: { chat: { keep: false, count: 0 } },
      drawings: { count: 0 },
    });

    // `.strict()`: a field this build has never heard of is refused, not stripped.
    expect((await call('PUT', '/api/v1/photos/home', memberToken, { room: true, everything: true })).statusCode).toBe(400);
    expect((await call('PUT', '/api/v1/photos/home', guestToken, { room: true })).statusCode).toBe(403);

    const on = await call('PUT', '/api/v1/photos/home', memberToken, { room: true, portrait: true });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ home: { room: { keep: true }, portrait: { keep: true } } });
    const logged = await db.select().from(activityTable).where(eq(activityTable.kind, 'photos.keep'));
    expect(logged.map((row) => row.message).sort()).toEqual([
      'Anna started keeping portrait photos on the hub.',
      'Anna started keeping room photos on the hub.',
    ]);
    // Turning a switch to where it already is writes nothing more.
    await call('PUT', '/api/v1/photos/home', memberToken, { room: true });
    expect(await db.select().from(activityTable).where(eq(activityTable.kind, 'photos.keep'))).toHaveLength(2);
  });

  it('keeps a drawing’s photos when asked, draws again from them, and lets each go with its last drawing', async () => {
    const [p1, p2, p3] = [bytes(400), bytes(400), bytes(400)];
    const first = await call('POST', '/api/v1/room-pictures', memberToken, {
      roomId: kitchenId,
      photos: [p1, p2].map((photo) => ({ data: photo.toString('base64'), type: 'image/jpeg' })),
      keepPhotos: true,
    });
    expect(first.statusCode).toBe(200);
    const firstId = (first.json() as { id: string }).id;
    expect(first.json()).toMatchObject({ photosKept: { kept: 2 } });
    await pictures.settled();

    const listed = (await call('GET', '/api/v1/room-pictures', memberToken)).json() as {
      pictures: { id: string; keptPhotos?: number }[];
    };
    expect(listed.pictures.find((picture) => picture.id === firstId)?.keptPhotos).toBe(2);
    const kept = (await call('GET', `/api/v1/room-pictures/${firstId}/photos`, memberToken)).json() as {
      photos: { id: string; bytes: number; takenBy?: { name: string } }[];
    };
    expect(kept.photos).toHaveLength(2);
    expect(kept.photos[0]).toMatchObject({ bytes: 400, takenBy: { name: 'Anna' } });
    const [k1, k2] = kept.photos.map((photo) => photo.id) as [string, string];

    // Drawn again from one kept photo and one new one.
    const again = await call('POST', '/api/v1/room-pictures', memberToken, {
      roomId: kitchenId,
      photos: [{ data: p3.toString('base64'), type: 'image/jpeg' }],
      keptPhotoIds: [k1],
      keepPhotos: true,
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ photosKept: { kept: 2 } });
    const secondId = (again.json() as { id: string }).id;
    await pictures.settled();
    const sent = (drawRoom.mock.calls.at(-2) as unknown as [{ images: { bytes: Buffer }[] }])[0].images;
    expect(sent).toHaveLength(2);
    expect(sent[0]!.bytes.equals(p1)).toBe(true);

    // A kept photo of the kitchen is not a photo of the hall.
    const elsewhere = await call('POST', '/api/v1/room-pictures', memberToken, {
      roomId: hallId,
      keptPhotoIds: [k1],
    });
    expect(elsewhere.statusCode).toBe(404);
    expect(elsewhere.json()).toEqual({ error: 'photo_not_found' });
    // And no photos at all is the 400 it always was.
    expect((await call('POST', '/api/v1/room-pictures', memberToken, { roomId: kitchenId, photos: [] })).statusCode).toBe(400);

    // The bytes, to whoever may draw — and to nobody else.
    const image = await call('GET', `/api/v1/photos/${k1}`, memberToken);
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/jpeg');
    expect(image.headers['cache-control']).toContain('private');
    expect(image.rawPayload.equals(p1)).toBe(true);
    expect((await call('GET', `/api/v1/photos/${k1}`, guestToken)).statusCode).toBe(403);

    // The first drawing goes: the photo the second was also drawn from stays.
    expect((await call('DELETE', `/api/v1/room-pictures/${firstId}`, memberToken)).statusCode).toBe(204);
    expect((await call('GET', `/api/v1/photos/${k1}`, memberToken)).statusCode).toBe(200);
    expect((await call('GET', `/api/v1/photos/${k2}`, memberToken)).statusCode).toBe(404);
    const left = (await call('GET', `/api/v1/room-pictures/${secondId}/photos`, memberToken)).json() as {
      photos: { id: string }[];
    };
    expect(left.photos.map((photo) => photo.id)).toContain(k1);
  });

  it('keeps nothing for an app that does not ask, whatever the switch says', async () => {
    const before = ((await call('GET', '/api/v1/photos', memberToken)).json() as { home: { room: { count: number } } })
      .home.room.count;
    const drawn = await call('POST', '/api/v1/room-pictures', memberToken, {
      roomId: hallId,
      photos: [{ data: bytes(300).toString('base64'), type: 'image/jpeg' }],
    });
    expect(drawn.statusCode).toBe(200);
    expect(drawn.json()).not.toHaveProperty('photosKept');
    await pictures.settled();
    const after = ((await call('GET', '/api/v1/photos', memberToken)).json() as { home: { room: { count: number } } })
      .home.room.count;
    expect(after).toBe(before);
  });

  it('keeps a portrait’s photo when asked, draws it again from it, and lets it go with its portrait', async () => {
    drawMock.mockResolvedValue({ png: Buffer.alloc(2048, 7), usage: { inputTextTokens: 200, inputImageTokens: 0, outputTokens: 4160 } });
    const photo = bytes(500);
    const drawn = await call('POST', `/api/v1/devices/${deviceId}/portraits`, memberToken, {
      photo: photo.toString('base64'),
      photoType: 'image/jpeg',
      keepPhoto: true,
    });
    expect(drawn.statusCode).toBe(200);
    const first = drawn.json() as { id: string; photo?: { id: string; bytes: number }; photosKept?: unknown };
    expect(first.photosKept).toEqual({ kept: 1 });
    expect(first.photo).toMatchObject({ bytes: 500 });
    const keptId = first.photo!.id;

    // Both at once is a mistake, not a guess.
    const both = await call('POST', `/api/v1/devices/${deviceId}/portraits`, memberToken, {
      photo: photo.toString('base64'),
      keptPhotoId: keptId,
    });
    expect(both.statusCode).toBe(400);

    const again = await call('POST', `/api/v1/devices/${deviceId}/portraits`, memberToken, { keptPhotoId: keptId });
    expect(again.statusCode).toBe(200);
    const second = again.json() as { id: string; photo?: { id: string } };
    expect(second.photo?.id).toBe(keptId);
    const handed = (drawMock.mock.calls.at(-1) as unknown as [{ photo?: { bytes: Buffer } }])[0].photo;
    expect(handed?.bytes.equals(photo)).toBe(true);

    expect((await call('DELETE', `/api/v1/portraits/${first.id}`, memberToken)).statusCode).toBe(204);
    expect((await call('GET', `/api/v1/photos/${keptId}`, memberToken)).statusCode).toBe(200);
    expect((await call('DELETE', `/api/v1/portraits/${second.id}`, memberToken)).statusCode).toBe(204);
    expect((await call('GET', `/api/v1/photos/${keptId}`, memberToken)).statusCode).toBe(404);
  });

  it('keeps a chat photo only for a sender who chose to, shows it to nobody else, and deletes it on request', async () => {
    const photo = bytes(1024);
    const attachment = { type: 'image', mediaType: 'image/jpeg', data: photo.toString('base64'), ref: 'phone-1' };

    // Asked, but Anna has not switched it on for herself.
    const unkept = await call('POST', '/api/v1/assistant/chat', memberToken, {
      message: 'what is this?',
      attachments: [attachment],
      keepPhotos: true,
    });
    expect(unkept.statusCode).toBe(201);
    expect(unkept.json()).toMatchObject({ photosKept: { kept: 0, reason: 'off' } });
    expect((unkept.json() as { messages: { data: { attachments: object[] } }[] }).messages[0]!.data.attachments[0]).not.toHaveProperty('kept');
    await idle();

    const mine = await call('PUT', '/api/v1/photos/mine', memberToken, { chat: true });
    expect(mine.json()).toMatchObject({ mine: { chat: { keep: true } } });

    const sent = await call('POST', '/api/v1/assistant/chat', memberToken, {
      message: 'and this?',
      attachments: [{ ...attachment, ref: 'phone-2' }],
      keepPhotos: true,
    });
    expect(sent.json()).toMatchObject({ photosKept: { kept: 1 } });
    const row = (sent.json() as { messages: { data: { attachments: { kept?: { id: string }; ref: string }[] } }[] })
      .messages[0]!;
    const keptId = row.data.attachments[0]!.kept!.id;
    expect(row.data.attachments[0]!.ref).toBe('phone-2');
    await idle();

    // An app that does not ask keeps nothing, switch or no switch.
    const older = await call('POST', '/api/v1/assistant/chat', memberToken, { message: 'old app', attachments: [attachment] });
    expect(older.json()).not.toHaveProperty('photosKept');
    await idle();

    const own = await call('GET', `/api/v1/photos/${keptId}`, memberToken);
    expect(own.statusCode).toBe(200);
    expect(own.rawPayload.equals(photo)).toBe(true);
    // Somebody else's chat photo does not exist, as far as anybody else knows —
    // the owner of the home included.
    expect((await call('GET', `/api/v1/photos/${keptId}`, ownerToken)).statusCode).toBe(404);
    expect((await call('DELETE', `/api/v1/photos/${keptId}`, ownerToken)).statusCode).toBe(404);

    // Still never in a row or a run: the file is the only copy.
    const needle = attachment.data.slice(0, 64);
    const everything = JSON.stringify([await db.select().from(automationChatMessages), await db.select().from(aiRuns)]);
    expect(everything).not.toContain(needle);

    const cleared = await call('DELETE', '/api/v1/photos/mine/chat', memberToken);
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ deleted: 1, mine: { chat: { count: 0 } } });
    expect((cleared.json() as { clearedAt?: string }).clearedAt).toBeTruthy();
    expect((await call('GET', `/api/v1/photos/${keptId}`, memberToken)).statusCode).toBe(404);
  });

  it('deletes every kept photo of one kind, with a line in the log', async () => {
    const before = ((await call('GET', '/api/v1/photos', memberToken)).json() as { home: { room: { count: number } } })
      .home.room.count;
    expect(before).toBeGreaterThan(0);
    const deleted = await call('DELETE', '/api/v1/photos/home/room', memberToken);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ deleted: before, home: { room: { count: 0, keep: true } } });
    const logged = await db.select().from(activityTable).where(eq(activityTable.kind, 'photos.deleted'));
    expect(logged.at(-1)?.message).toBe(
      before === 1 ? 'Anna deleted the 1 room photo the hub kept.' : `Anna deleted the ${before} room photos the hub kept.`,
    );
  });

  it('takes a member’s chat photos with them when they leave', async () => {
    const leaverToken = await join('Masha', 'member');
    await call('PUT', '/api/v1/photos/mine', leaverToken, { chat: true });
    const sent = await call('POST', '/api/v1/assistant/chat', leaverToken, {
      message: 'look',
      attachments: [{ type: 'image', mediaType: 'image/jpeg', data: bytes(200).toString('base64') }],
      keepPhotos: true,
    });
    const keptId = (sent.json() as { messages: { data: { attachments: { kept: { id: string } }[] } }[] }).messages[0]!
      .data.attachments[0]!.kept.id;
    await idle();
    expect(await photos.get(keptId)).not.toBeNull();
    expect((await call('DELETE', '/api/v1/members/me', leaverToken)).statusCode).toBeLessThan(300);
    expect(await photos.get(keptId)).toBeNull();
  });
});
