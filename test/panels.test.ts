import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { HubEventBus } from '../src/core/bus.js';
import { devicePanels, devices } from '../src/db/schema.js';
import { PANEL_KINDS, PanelService, pathProblem, type PanelUpload } from '../src/panels/store.js';
import { openTestDb } from './helpers/db.js';

const handle = await openTestDb();
const log = pino({ level: 'silent' });

const file = (filePath: string, text: string) => ({ path: filePath, dataBase64: Buffer.from(text).toString('base64') });
const panel = (files: PanelUpload['files'], title = 'Weather', kind = 'web'): PanelUpload => ({ kind, title, files });

describe.skipIf(!handle)('panels', () => {
  const db = handle?.db!;
  let dataDir: string;
  let events: HubEventBus;
  let store: PanelService;
  let deviceId: string;
  let changes: string[];

  beforeEach(async () => {
    await db.delete(devices);
    dataDir = mkdtempSync(path.join(tmpdir(), 'gethome-panels-'));
    events = new HubEventBus();
    changes = [];
    events.on('panelsChanged', (id) => changes.push(id));
    store = new PanelService(db, events, dataDir, log);
    const [row] = await db
      .insert(devices)
      .values({ adapter: 'mqtt', externalId: 'desk-display', name: 'Desk display' })
      .returning();
    deviceId = row!.id;
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('installs a panel, lists it with its kind, and serves its files from the manifest', async () => {
    const result = await store.put(
      deviceId,
      'weather',
      panel([file('index.html', '<script src="app.js"></script>'), file('app.js', 'console.log(1)')]),
      { id: 'm1', name: 'Anna' },
    );
    expect(result.changed).toBe(true);
    expect(store.list(deviceId)).toEqual([
      {
        id: 'weather',
        kind: 'web',
        title: 'Weather',
        height: 240,
        sha256: result.panel.sha256,
        updatedAt: result.panel.updatedAt,
      },
    ]);
    const index = await store.file(deviceId, 'weather', '');
    expect(index?.data.toString()).toBe('<script src="app.js"></script>');
    expect(index?.file.type).toBe('text/html; charset=utf-8');
    expect((await store.file(deviceId, 'weather', 'app.js'))?.file.type).toBe('text/javascript; charset=utf-8');
    // Not in the manifest, so not served — whatever is on disk.
    expect(await store.file(deviceId, 'weather', '../../../etc/passwd')).toBeNull();
    expect(await store.file(deviceId, 'weather', 'missing.css')).toBeNull();
    expect(changes).toEqual([deviceId]);
  });

  it('says which kinds it keeps, each with its own bounds', () => {
    expect(store.describe()).toEqual({ perDevice: 4, kinds: { web: { maxBytes: 512 * 1024, maxFiles: 64 } } });
    // Every kind the store takes is one `GET /hub` names, so a client that
    // reads `kinds` never offers one this hub would refuse.
    expect(Object.keys(store.describe().kinds).sort()).toEqual([...PANEL_KINDS].sort());
  });

  it('refuses a kind it does not keep, before looking at anything else', async () => {
    await expect(store.put(deviceId, 'gauge', panel([], 'Gauge', 'native'), null)).rejects.toMatchObject({
      code: 'unsupported_panel_kind',
    });
    expect(store.list(deviceId)).toEqual([]);
    expect(changes).toEqual([]);
  });

  it('writes nothing for an upload identical to what is there', async () => {
    const upload = panel([file('index.html', '<p>1</p>')]);
    await store.put(deviceId, 'panel', upload, null);
    const again = await store.put(deviceId, 'panel', upload, null);
    expect(again.changed).toBe(false);
    expect(changes).toHaveLength(1);
    const changed = await store.put(deviceId, 'panel', panel([file('index.html', '<p>2</p>')]), null);
    expect(changed.changed).toBe(true);
    expect((await store.file(deviceId, 'panel', 'index.html'))?.data.toString()).toBe('<p>2</p>');
  });

  it('refuses what a web panel may not be', async () => {
    const big = Buffer.alloc(600 * 1024, 65).toString('base64');
    const cases: Array<[string, string, PanelUpload]> = [
      ['no index.html', 'panel', panel([file('app.js', 'x')])],
      ['a bad id', 'Bad_Id', panel([file('index.html', 'x')])],
      ['a path up and out', 'panel', panel([file('index.html', 'x'), file('../escape.js', 'x')])],
      ['a hidden file', 'panel', panel([file('index.html', 'x'), file('.env', 'x')])],
      ['a type nobody serves', 'panel', panel([file('index.html', 'x'), file('run.sh', 'x')])],
      ['not base64', 'panel', panel([{ path: 'index.html', dataBase64: 'not base64!' }])],
      ['too big', 'panel', panel([{ path: 'index.html', dataBase64: big }])],
      ['the same file twice', 'panel', panel([file('index.html', 'a'), file('index.html', 'b')])],
      ['no title', 'panel', panel([file('index.html', 'x')], '  ')],
    ];
    for (const [why, id, upload] of cases) {
      await expect(store.put(deviceId, id, upload, null), why).rejects.toMatchObject({ code: 'invalid_panel' });
    }
    expect(store.list(deviceId)).toEqual([]);
    expect(pathProblem('css/site.css')).toBeNull();
    expect(pathProblem('a/b/c/d/e.css')).not.toBeNull();
    expect(pathProblem('_app/theme.css')).not.toBeNull();
  });

  it('holds a few panels per device', async () => {
    for (const id of ['a', 'b', 'c', 'd']) await store.put(deviceId, id, panel([file('index.html', id)]), null);
    await expect(store.put(deviceId, 'e', panel([file('index.html', 'e')]), null)).rejects.toMatchObject({
      code: 'too_many_panels',
    });
    // Replacing one that is there is not a fifth.
    await expect(store.put(deviceId, 'a', panel([file('index.html', 'a2')]), null)).resolves.toMatchObject({ changed: true });
  });

  it('counts uploads that arrive together one at a time', async () => {
    const results = await Promise.allSettled(
      ['a', 'b', 'c', 'd', 'e'].map((id) => store.put(deviceId, id, panel([file('index.html', id)]), null)),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(4);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    // None of the four was lost from what GET /devices reads.
    expect(store.list(deviceId).map((entry) => entry.id).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('removes a panel, and every panel with its device', async () => {
    await store.put(deviceId, 'one', panel([file('index.html', '1')]), null);
    await store.put(deviceId, 'two', panel([file('index.html', '2')]), null);
    expect(await store.remove(deviceId, 'one')).toBe(true);
    expect(await store.remove(deviceId, 'one')).toBe(false);
    expect(store.list(deviceId).map((entry) => entry.id)).toEqual(['two']);

    events.emit('deviceRemoved', deviceId);
    for (let i = 0; i < 50 && existsSync(path.join(dataDir, 'panels', deviceId)); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(store.list(deviceId)).toEqual([]);
    expect(existsSync(path.join(dataDir, 'panels', deviceId))).toBe(false);
  });

  it('reads what an earlier boot stored', async () => {
    await store.put(deviceId, 'weather', panel([file('index.html', 'w')]), null);
    const reborn = new PanelService(db, new HubEventBus(), dataDir, log);
    await reborn.load();
    expect(reborn.list(deviceId).map((entry) => [entry.id, entry.kind])).toEqual([['weather', 'web']]);
    expect((await reborn.file(deviceId, 'weather', 'index.html'))?.data.toString()).toBe('w');
    // Nothing but the panel itself is left in the device's folder.
    expect(readdirSync(path.join(dataDir, 'panels', deviceId))).toEqual(['weather']);
  });

  it('keeps a panel of a kind a newer build wrote, and lists it as it is', async () => {
    // A hub that rolled back meets a row of a kind it has never heard of. It
    // is the newer build's, so it is carried rather than dropped: listed with
    // its own kind, which an app that doesn't draw it leaves off the page,
    // and counted against the device's panels.
    await db.insert(devicePanels).values({
      deviceId,
      panelId: 'later',
      kind: 'native',
      title: 'Later',
      sha256: 'f'.repeat(64),
      bytes: 10,
      height: 120,
      manifest: [],
      updatedAt: new Date(),
      memberId: null,
      memberName: null,
    });
    const reborn = new PanelService(db, new HubEventBus(), dataDir, log);
    await reborn.load();
    expect(reborn.list(deviceId)).toEqual([expect.objectContaining({ id: 'later', kind: 'native', title: 'Later' })]);
    for (const id of ['a', 'b', 'c']) await reborn.put(deviceId, id, panel([file('index.html', id)]), null);
    await expect(reborn.put(deviceId, 'd', panel([file('index.html', 'd')]), null)).rejects.toMatchObject({
      code: 'too_many_panels',
    });
  });

  it('gives one id one panel, whatever kind each upload is', async () => {
    // The store keys on the id alone, so a later kind replacing a panel under
    // an id is a replacement — never a second panel the apps would draw under
    // the same layout word.
    await store.put(deviceId, 'gauge', panel([file('index.html', '1')], 'Gauge'), null);
    await store.put(deviceId, 'gauge', panel([file('index.html', '2')], 'Gauge'), null);
    expect(store.list(deviceId).map((entry) => entry.id)).toEqual(['gauge']);
  });
});
