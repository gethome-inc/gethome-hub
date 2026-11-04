import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { measureSpace, spaceOf } from '../src/photos/space.js';

/**
 * `GET /photos` sends `space` for one bar and one sentence — "51.55 GB free of
 * 58.39 GB" — so its two figures have to add up: whatever is not free has to
 * be something stored. ext4's root reserve is the part that breaks that.
 */
describe('the space a hub reports for photos', () => {
  // A 64 GB card read on a Zero 2 W: `stat -f` beside `df -B1` on the same
  // partition, at the same moment.
  const card = { blocks: 14_878_962, bfree: 13_207_594, bavail: 12_584_525, bsize: 4096 };
  const dfUsed = 6_845_923_328;
  const dfAvail = 51_546_214_400;

  it('leaves root’s reserve out of the total as well as out of what is free', () => {
    const space = spaceOf(card);
    expect(space.freeBytes).toBe(dfAvail);
    // Total less free is what is really on the card, and not the 2.55 GB
    // reserve on top of it.
    expect(space.totalBytes - space.freeBytes).toBe(dfUsed);
    expect(space.totalBytes).toBe(58_392_137_728);
  });

  it('is the whole partition where nothing is reserved', () => {
    expect(spaceOf({ blocks: 1000, bfree: 400, bavail: 400, bsize: 4096 })).toEqual({
      totalBytes: 1000 * 4096,
      freeBytes: 400 * 4096,
    });
  });

  it('never reads a negative reserve or a negative total', () => {
    expect(spaceOf({ blocks: 1000, bfree: 300, bavail: 400, bsize: 512 }).totalBytes).toBe(1000 * 512);
    expect(spaceOf({ blocks: 10, bfree: 50, bavail: 0, bsize: 512 }).totalBytes).toBe(0);
  });

  const dir = mkdtempSync(path.join(tmpdir(), 'gethome-space-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('measures a real directory, creating it when it is not there yet', async () => {
    const missing = path.join(dir, 'data', 'photos');
    const space = await measureSpace(missing);
    expect(space).not.toBeNull();
    expect(space!.totalBytes).toBeGreaterThan(0);
    expect(space!.freeBytes).toBeLessThanOrEqual(space!.totalBytes);
  });
});
