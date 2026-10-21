import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { HubEventBus } from '../src/core/bus.js';
import { devices } from '../src/db/schema.js';
import { WebBlockService, pathProblem, type WebBlockUpload } from '../src/web-blocks/store.js';
import { openTestDb } from './helpers/db.js';

const handle = await openTestDb();
const log = pino({ level: 'silent' });

const file = (filePath: string, text: string) => ({ path: filePath, dataBase64: Buffer.from(text).toString('base64') });
const block = (files: WebBlockUpload['files'], title = 'Weather'): WebBlockUpload => ({ title, files });

describe.skipIf(!handle)('web blocks', () => {
  const db = handle?.db!;
  let dataDir: string;
  let events: HubEventBus;
  let store: WebBlockService;
  let deviceId: string;
  let changes: string[];

  beforeEach(async () => {
    await db.delete(devices);
    dataDir = mkdtempSync(path.join(tmpdir(), 'gethome-web-blocks-'));
    events = new HubEventBus();
    changes = [];
    events.on('webBlocksChanged', (id) => changes.push(id));
    store = new WebBlockService(db, events, dataDir, log);
    const [row] = await db
      .insert(devices)
      .values({ adapter: 'mqtt', externalId: 'desk-display', name: 'Desk display' })
      .returning();
    deviceId = row!.id;
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('installs a block, lists it, and serves its files from the manifest', async () => {
    const result = await store.put(
      deviceId,
      'weather',
      block([file('index.html', '<script src="app.js"></script>'), file('app.js', 'console.log(1)')]),
      { id: 'm1', name: 'Anna' },
    );
    expect(result.changed).toBe(true);
    expect(store.list(deviceId)).toEqual([
      { id: 'weather', title: 'Weather', height: 240, sha256: result.block.sha256, updatedAt: result.block.updatedAt },
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

  it('writes nothing for an upload identical to what is there', async () => {
    const upload = block([file('index.html', '<p>1</p>')]);
    await store.put(deviceId, 'panel', upload, null);
    const again = await store.put(deviceId, 'panel', upload, null);
    expect(again.changed).toBe(false);
    expect(changes).toHaveLength(1);
    const changed = await store.put(deviceId, 'panel', block([file('index.html', '<p>2</p>')]), null);
    expect(changed.changed).toBe(true);
    expect((await store.file(deviceId, 'panel', 'index.html'))?.data.toString()).toBe('<p>2</p>');
  });

  it('refuses what a block may not be', async () => {
    const big = Buffer.alloc(600 * 1024, 65).toString('base64');
    const cases: Array<[string, string, WebBlockUpload]> = [
      ['no index.html', 'panel', block([file('app.js', 'x')])],
      ['a bad id', 'Bad_Id', block([file('index.html', 'x')])],
      ['a path up and out', 'panel', block([file('index.html', 'x'), file('../escape.js', 'x')])],
      ['a hidden file', 'panel', block([file('index.html', 'x'), file('.env', 'x')])],
      ['a type nobody serves', 'panel', block([file('index.html', 'x'), file('run.sh', 'x')])],
      ['not base64', 'panel', block([{ path: 'index.html', dataBase64: 'not base64!' }])],
      ['too big', 'panel', block([{ path: 'index.html', dataBase64: big }])],
      ['the same file twice', 'panel', block([file('index.html', 'a'), file('index.html', 'b')])],
      ['no title', 'panel', block([file('index.html', 'x')], '  ')],
    ];
    for (const [why, id, upload] of cases) {
      await expect(store.put(deviceId, id, upload, null), why).rejects.toMatchObject({ code: 'invalid_block' });
    }
    expect(store.list(deviceId)).toEqual([]);
    expect(pathProblem('css/site.css')).toBeNull();
    expect(pathProblem('a/b/c/d/e.css')).not.toBeNull();
    expect(pathProblem('_app/theme.css')).not.toBeNull();
  });

  it('holds a few blocks per device', async () => {
    for (const id of ['a', 'b', 'c', 'd']) await store.put(deviceId, id, block([file('index.html', id)]), null);
    await expect(store.put(deviceId, 'e', block([file('index.html', 'e')]), null)).rejects.toMatchObject({
      code: 'too_many_web_blocks',
    });
    // Replacing one that is there is not a fifth.
    await expect(store.put(deviceId, 'a', block([file('index.html', 'a2')]), null)).resolves.toMatchObject({ changed: true });
  });

  it('counts uploads that arrive together one at a time', async () => {
    const results = await Promise.allSettled(
      ['a', 'b', 'c', 'd', 'e'].map((id) => store.put(deviceId, id, block([file('index.html', id)]), null)),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(4);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    // None of the four was lost from what GET /devices reads.
    expect(store.list(deviceId).map((entry) => entry.id).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('removes a block, and every block with its device', async () => {
    await store.put(deviceId, 'one', block([file('index.html', '1')]), null);
    await store.put(deviceId, 'two', block([file('index.html', '2')]), null);
    expect(await store.remove(deviceId, 'one')).toBe(true);
    expect(await store.remove(deviceId, 'one')).toBe(false);
    expect(store.list(deviceId).map((entry) => entry.id)).toEqual(['two']);

    events.emit('deviceRemoved', deviceId);
    for (let i = 0; i < 50 && existsSync(path.join(dataDir, 'web-blocks', deviceId)); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(store.list(deviceId)).toEqual([]);
    expect(existsSync(path.join(dataDir, 'web-blocks', deviceId))).toBe(false);
  });

  it('reads what an earlier boot stored', async () => {
    await store.put(deviceId, 'weather', block([file('index.html', 'w')]), null);
    const reborn = new WebBlockService(db, new HubEventBus(), dataDir, log);
    await reborn.load();
    expect(reborn.list(deviceId).map((entry) => entry.id)).toEqual(['weather']);
    expect((await reborn.file(deviceId, 'weather', 'index.html'))?.data.toString()).toBe('w');
    // Nothing but the block itself is left in the device's folder.
    expect(readdirSync(path.join(dataDir, 'web-blocks', deviceId))).toEqual(['weather']);
  });
});
