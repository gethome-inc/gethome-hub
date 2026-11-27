import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describeOrigin, readStoredOrigin } from '../src/automations/origin.js';
import { AutomationStore } from '../src/automations/store.js';
import * as schema from '../src/db/schema.js';

/**
 * Where a rule came from, with no server in front of it: the sentence the hub
 * writes, the column read back tolerantly, and — the half only this suite can
 * reach — what a hub that already has rules ends up holding.
 *
 * `test/automations-api.test.ts` holds the wire, route by route.
 */

const anna = { id: '11111111-1111-4111-a111-111111111111', name: 'Anna' };

describe('the sentence', () => {
  it('names the member, and how the rule arrived when that is worth saying', () => {
    expect(describeOrigin({ stored: { kind: 'chat' }, member: anna })?.sentence).toBe(
      'Added by Anna in a chat',
    );
    expect(
      describeOrigin({
        stored: { kind: 'template', template: 'night' },
        member: anna,
        templateTitle: 'Night',
      })?.sentence,
    ).toBe('Added by Anna from the “Night” template');
    // A document is how every rule is stored; saying so would say nothing.
    expect(describeOrigin({ stored: { kind: 'document' }, member: anna })?.sentence).toBe(
      'Added by Anna',
    );
  });

  it('still says a template was one when this build no longer ships it', () => {
    const origin = describeOrigin({
      stored: { kind: 'template', template: 'retired_preset' },
      member: anna,
    });
    expect(origin).toMatchObject({
      sentence: 'Added by Anna from a template',
      template: 'retired_preset',
    });
    expect(origin?.templateTitle).toBeUndefined();
  });

  it('names an API key the way an activity row does, and marks it the same way', () => {
    const stored = { kind: 'document', apiKeyId: 'key-1', apiKeyName: 'Node-RED' };
    expect(describeOrigin({ stored, member: anna })).toEqual({
      sentence: 'Added by Anna’s “Node-RED”',
      kind: 'document',
      memberId: anna.id,
      memberName: 'Anna',
      via: 'api',
      apiKeyId: 'key-1',
      apiKeyName: 'Node-RED',
    });
    // The key's name today wins over the one it had; the stored one is for a
    // key that is gone.
    expect(describeOrigin({ stored, member: anna, apiKeyName: 'Flows' })).toMatchObject({
      sentence: 'Added by Anna’s “Flows”',
      apiKeyName: 'Flows',
    });
    // Removing a member takes their keys with them, so this is what is left.
    expect(describeOrigin({ stored, member: null })?.sentence).toBe(
      'Added by the API key “Node-RED”',
    );
  });

  it('never borrows a key’s name for a rule no key sent', () => {
    // The wire resolves names by id; a stray one must not turn a person's
    // rule into a script's.
    const origin = describeOrigin({ stored: { kind: 'chat' }, member: anna, apiKeyName: 'Flows' });
    expect(origin?.sentence).toBe('Added by Anna in a chat');
    expect(origin?.via).toBeUndefined();
    expect(origin?.apiKeyName).toBeUndefined();
  });

  it('says how without who, once the member has left', () => {
    expect(describeOrigin({ stored: { kind: 'chat' }, member: null })).toEqual({
      sentence: 'Added in a chat',
      kind: 'chat',
    });
  });

  it('says who without how, for a rule from before the hub kept it', () => {
    expect(describeOrigin({ stored: null, member: anna })).toEqual({
      sentence: 'Added by Anna',
      memberId: anna.id,
      memberName: 'Anna',
    });
  });

  it('says nothing at all rather than something untrue', () => {
    expect(describeOrigin({ stored: null, member: null })).toBeNull();
    expect(describeOrigin({ stored: { kind: 'document' }, member: null })).toBeNull();
  });

  it('carries a kind it has never met, and falls back to who', () => {
    // What a build meets after `install.sh` rolls back past the one that
    // wrote the word. The word goes through untouched for the app to read,
    // and the sentence stays true.
    expect(describeOrigin({ stored: { kind: 'imported' }, member: anna })).toEqual({
      sentence: 'Added by Anna',
      kind: 'imported',
      memberId: anna.id,
      memberName: 'Anna',
    });
  });
});

describe('reading the column back', () => {
  it('keeps what it knows and drops what it does not', () => {
    expect(readStoredOrigin({ kind: 'template', template: 'away', later: true })).toEqual({
      kind: 'template',
      template: 'away',
    });
  });

  it('answers null for anything that is not an origin, and never throws', () => {
    for (const raw of [null, undefined, 'chat', 7, [], {}, { kind: '' }, { kind: 3 }]) {
      expect(readStoredOrigin(raw)).toBeNull();
    }
  });
});

/**
 * A hub that already has rules.
 *
 * Every other suite builds its database from all the migrations at once, so it
 * can only say what a *new* rule holds. The rules already in people's homes
 * were saved by builds that kept no origin — only a note on the version each
 * was created with — and this is what `0022` makes of them, against rows
 * written the way those builds wrote them.
 */
describe('the origin migration', () => {
  const migrationsDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'src',
    'db',
    'migrations',
  );
  const migrationFiles = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  /** Named, not counted — `test/roles-migration.test.ts` says why. */
  const ORIGIN_MIGRATION = migrationFiles.findIndex((name) => name.startsWith('0022_')) + 1;

  function apply(sqlite: Database.Database, from: number, to: number): void {
    for (const name of migrationFiles.slice(from, to)) {
      const sql = readFileSync(path.join(migrationsDir, name), 'utf8');
      for (const statement of sql.split('--> statement-breakpoint')) {
        const trimmed = statement.trim();
        if (trimmed.length > 0) sqlite.exec(trimmed);
      }
    }
  }

  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('reads how a rule arrived out of the notes an older build left, and guesses nothing', async () => {
    expect(ORIGIN_MIGRATION).toBeGreaterThan(0);
    dir = mkdtempSync(path.join(tmpdir(), 'gethome-origin-migration-'));
    const sqlite = new Database(path.join(dir, 'hub.db'));
    sqlite.pragma('foreign_keys = ON');
    apply(sqlite, 0, ORIGIN_MIGRATION - 1);

    const document = JSON.stringify({
      version: 1,
      name: 'Rule',
      mode: 'single',
      triggers: [{ kind: 'manual' }],
      actions: [{ kind: 'logActivity', message: 'hello' }],
    });
    const now = Date.now();
    const rule = sqlite.prepare(
      'INSERT INTO automations (id, name, enabled, active, document, sort_order, created_at, updated_at) VALUES (?, ?, 0, 0, ?, ?, ?, ?)',
    );
    const version = sqlite.prepare(
      'INSERT INTO automation_versions (id, automation_id, at, document, note) VALUES (?, ?, ?, ?, ?)',
    );
    /** A rule as an older build left it: its versions' notes, oldest first. */
    const seed = (id: string, notes: string[]) => {
      rule.run(id, 'Rule', document, 0, now, now);
      notes.forEach((note, index) => {
        version.run(`${id}-v${index}`, id, now + index, document, note);
      });
    };

    seed('chat', ['written in chat', 'edited in chat', 'edited']);
    seed('template', ['from motion_light', 'edited']);
    // A document sent with a sign-in and one sent with a key left the same
    // note, so the hub cannot say which this was.
    seed('plain', ['created', 'edited in chat']);
    // Edited more than ten times: the note that said how it arrived is gone.
    seed('evicted', ['edited', 'edited in chat', 'reverted']);
    seed('nothing', []);

    apply(sqlite, ORIGIN_MIGRATION - 1, migrationFiles.length);

    const { records } = await new AutomationStore(drizzle(sqlite, { schema })).load();
    const origin = (id: string) => records.find((record) => record.id === id)?.origin;
    expect(records).toHaveLength(5);
    expect(origin('chat')).toEqual({ kind: 'chat' });
    expect(origin('template')).toEqual({ kind: 'template', template: 'motion_light' });
    expect(origin('plain')).toBeNull();
    expect(origin('evicted')).toBeNull();
    expect(origin('nothing')).toBeNull();
    sqlite.close();
  });

  it('leaves alone an origin a rule already has', () => {
    // The statements are written to be safe to meet twice — a hub that
    // installed this from a branch under another number has the column filled
    // already, and a renumbered migration is one drizzle has never seen.
    dir = mkdtempSync(path.join(tmpdir(), 'gethome-origin-migration-'));
    const sqlite = new Database(path.join(dir, 'hub.db'));
    apply(sqlite, 0, migrationFiles.length);
    const now = Date.now();
    sqlite
      .prepare(
        'INSERT INTO automations (id, name, enabled, active, document, origin, sort_order, created_at, updated_at) VALUES (?, ?, 0, 0, ?, ?, 0, ?, ?)',
      )
      .run('kept', 'Rule', '{}', JSON.stringify({ kind: 'document', apiKeyName: 'Flows' }), now, now);
    sqlite
      .prepare(
        'INSERT INTO automation_versions (id, automation_id, at, document, note) VALUES (?, ?, ?, ?, ?)',
      )
      .run('kept-v0', 'kept', now, '{}', 'written in chat');

    const backfill = readFileSync(
      path.join(migrationsDir, migrationFiles[ORIGIN_MIGRATION - 1]!),
      'utf8',
    )
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter((statement) => /^(--.*\n)*UPDATE/.test(statement));
    expect(backfill).toHaveLength(2);
    for (const statement of backfill) sqlite.exec(statement);

    const row = sqlite.prepare('SELECT origin FROM automations WHERE id = ?').get('kept') as {
      origin: string;
    };
    expect(JSON.parse(row.origin)).toEqual({ kind: 'document', apiKeyName: 'Flows' });
    sqlite.close();
  });
});
