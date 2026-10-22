import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HubEventBus } from '../src/core/bus.js';
import { MAX_SPACE_BYTES, SpaceSaveError, SpaceStore } from '../src/core/space.js';

const author = { id: 'member-1', name: 'Georgy' };
const plan = { format: 1, rooms: [{ id: 'living' }], placements: [] };

describe('SpaceStore', () => {
  it('starts empty, saves, and reads back after a restart', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gethome-space-'));
    const store = new SpaceStore(dir);
    expect(store.read()).toMatchObject({ space: null, revision: 0, updatedBy: null });

    store.save(plan, 0, author);
    // A new process reads what the last one wrote — the file is the record.
    const reopened = new SpaceStore(dir);
    expect(reopened.read()).toMatchObject({ space: plan, revision: 1, updatedBy: author });
  });

  it('refuses a save made against an older revision, and writes nothing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gethome-space-'));
    const store = new SpaceStore(dir);
    store.save(plan, 0, author);
    expect(() => store.save({ ...plan, rooms: [] }, 0, author)).toThrow(SpaceSaveError);
    expect(store.read()).toMatchObject({ space: plan, revision: 1 });
    // No base revision is a save that does not care — the first scan of a
    // phone that has never read the plan.
    expect(store.save({ ...plan, rooms: [] }, undefined, author).revision).toBe(2);
  });

  it('refuses a plan larger than the hub keeps', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gethome-space-'));
    const store = new SpaceStore(dir);
    const huge = { ...plan, padding: 'x'.repeat(MAX_SPACE_BYTES) };
    expect(() => store.save(huge, 0, author)).toThrowError(/space_too_large/);
    expect(store.read().revision).toBe(0);
  });

  it('treats an unreadable file as no plan rather than failing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gethome-space-'));
    new SpaceStore(dir).save(plan, 0, author);
    const file = path.join(dir, 'space', 'plan.json');
    writeFileSync(file, '{ not json');
    expect(new SpaceStore(dir).read()).toMatchObject({ space: null, revision: 0 });
  });

  it('says so on the bus, so every open app hears the plan moved', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gethome-space-'));
    const events = new HubEventBus();
    const heard: number[] = [];
    events.on('spaceChanged', (revision) => heard.push(revision));
    const store = new SpaceStore(dir, events);
    store.save(plan, 0, author);
    store.clear(author);
    expect(heard).toEqual([1, 2]);
    expect(JSON.parse(readFileSync(path.join(dir, 'space', 'plan.json'), 'utf8'))).toMatchObject({ space: null, revision: 2 });
  });
});
