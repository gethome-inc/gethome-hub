import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canApplyUpdate,
  checkForUpdate,
  forgetUpdateCheck,
  parseBuild,
  readUpdateLog,
  readUpdateRun,
  recordFinishedUpdate,
  requestUpdate,
} from '../src/core/update.js';

/**
 * `src/core/update.ts` — the hub's half of updating itself.
 *
 * Everything here is either "read a file a root process wrote" or "ask GitHub
 * one question", and the failure mode both share is answering confidently when
 * they should be saying they cannot tell. That is what most of this pins.
 */

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gethome-update-core-'));
  dirs.push(dir);
  mkdirSync(path.join(dir, 'update'), { recursive: true });
  return dir;
}
afterEach(() => {
  vi.unstubAllGlobals();
  forgetUpdateCheck();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function writeStatus(dataDir: string, status: Record<string, unknown>): void {
  writeFileSync(
    path.join(dataDir, 'update', 'status.json'),
    JSON.stringify({
      id: 'run-1',
      state: 'succeeded',
      step: 'done',
      startedAt: '2026-08-24T18:00:00Z',
      heartbeat: '2026-08-24T18:05:00Z',
      fromBuild: '0.1.0-1590564-main',
      hubAnswering: true,
      warnings: [],
      ...status,
    }),
  );
}

describe('reading the build stamp', () => {
  it('finds the commit in CI\'s stamp', () => {
    expect(parseBuild('0.1.0-1590564-main')).toEqual({
      build: '0.1.0-1590564-main',
      version: '0.1.0',
      sha: '1590564',
      channel: 'main',
    });
  });

  it('keeps a branch name that contains dashes', () => {
    // Only the first two fields are positional, which is the whole reason this
    // is a function rather than a split.
    expect(parseBuild('0.1.0-abc1234-claude/ios-hub-updates')?.channel)
      .toBe('claude/ios-hub-updates');
  });

  it('refuses a hub built from source rather than guessing', () => {
    // No stamp is the difference between "up to date" and "cannot say", and
    // collapsing them would tell somebody they are current on no evidence.
    expect(parseBuild(undefined)).toBeUndefined();
    expect(parseBuild('')).toBeUndefined();
    expect(parseBuild('0.1.0')).toBeUndefined();
    expect(parseBuild('0.1.0-notahex-main'), 'the middle field must be a commit').toBeUndefined();
    expect(parseBuild('0.1.0-abc12-main'), 'and a long enough one').toBeUndefined();
  });
});

describe('the runner\'s status file', () => {
  it('is absent, not an error, on a hub that has never updated', () => {
    expect(readUpdateRun(tmp())).toBeUndefined();
  });

  it('never throws on a file it cannot parse', () => {
    // The runner renames its status into place, but a build that changed the
    // shape, or a truncated card, must not take out the only route an app has
    // to learn anything about updating.
    const data = tmp();
    writeFileSync(path.join(data, 'update', 'status.json'), '{"id":"x","state":"go');
    expect(readUpdateRun(data)).toBeUndefined();
  });

  it('reports a run whose heartbeat stopped as stalled', () => {
    // The board lost power, or the OOM killer took the runner. Left alone the
    // file says `running` for ever: a progress bar that never moves and a 409
    // on every attempt to try again — one power cut locking the hub out of
    // being updated from an app at all.
    const data = tmp();
    const start = Date.parse('2026-08-24T18:00:00Z');
    writeStatus(data, { state: 'running', heartbeat: '2026-08-24T18:00:00Z' });
    expect(readUpdateRun(data, start + 60_000)?.state, 'a minute in is just slow').toBe('running');
    expect(readUpdateRun(data, start + 21 * 60_000)?.state).toBe('stalled');
  });

  it('leaves a finished run alone however old it is', () => {
    const data = tmp();
    writeStatus(data, { state: 'succeeded', heartbeat: '2020-01-01T00:00:00Z' });
    expect(readUpdateRun(data, Date.now())?.state).toBe('succeeded');
  });
});

describe('asking for an update', () => {
  it('writes an id the runner will accept', () => {
    const data = tmp();
    const id = requestUpdate(data);
    const written = readFileSync(path.join(data, 'update', 'request'), 'utf8').trim();
    expect(written).toBe(id);
    // The runner validates with ^[A-Za-z0-9._-]{8,64}$ before acting on it, so
    // a shape it would reject is a request that silently does nothing.
    expect(written).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
  });

  it('is only offered on a machine that has the plumbing', () => {
    // install.sh touches this in the same breath as it writes the units, so it
    // cannot promise a runner that was never installed.
    const data = tmp();
    expect(canApplyUpdate(data)).toBe(false);
    writeFileSync(path.join(data, 'update', 'enabled'), '');
    expect(canApplyUpdate(data)).toBe(true);
  });
});

describe('is there anything newer', () => {
  function githubAnswers(status: number, body: string) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })));
  }

  it('reads the branch head', async () => {
    githubAnswers(200, '1590564a8da586c15cf74df06c1f3cae0741fced\n');
    expect(await checkForUpdate()).toMatchObject({ sha: '1590564' });
  });

  it('says rate-limited rather than up to date', async () => {
    // Every phone in the house shares the hub's address, and unauthenticated
    // GitHub allows sixty an hour. Reporting that as "no update" would be a
    // confident answer built on no information.
    githubAnswers(403, '{"message":"API rate limit exceeded"}');
    expect(await checkForUpdate()).toEqual({ error: 'rate_limited' });
  });

  it('says offline when the call throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ENOTFOUND'); }));
    expect(await checkForUpdate()).toEqual({ error: 'offline' });
  });

  it('refuses an answer that is not a commit', async () => {
    githubAnswers(200, '<html>a captive portal</html>');
    expect(await checkForUpdate()).toEqual({ error: 'offline' });
  });

  it('asks once and then remembers', async () => {
    const fetcher = vi.fn(async () => new Response('a86c1dcabcdef1234567890abcdef1234567890a', { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    await checkForUpdate();
    await checkForUpdate();
    await checkForUpdate();
    expect(fetcher, 'a hub nobody looks at never calls out; one that is looked at often still asks once')
      .toHaveBeenCalledTimes(1);
  });

  it('holds a floor under an explicit refresh', async () => {
    const fetcher = vi.fn(async () => new Response('a86c1dcabcdef1234567890abcdef1234567890a', { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const now = Date.now();
    await checkForUpdate(false, now);
    await checkForUpdate(true, now + 5_000);
    expect(fetcher, 'a Check again button must not become a way to spend the hour\'s quota').toHaveBeenCalledTimes(1);
    await checkForUpdate(true, now + 120_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('the installer log', () => {
  it('is empty, not an error, before anything has run', () => {
    expect(readUpdateLog(tmp(), 10)).toEqual({ lines: [], total: 0, truncated: false });
  });

  it('gives back the tail and says there was more', () => {
    const data = tmp();
    writeFileSync(
      path.join(data, 'update', 'last.log'),
      Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') + '\n',
    );
    const tail = readUpdateLog(data, 5);
    expect(tail.lines).toEqual(['line 45', 'line 46', 'line 47', 'line 48', 'line 49']);
    expect(tail.total).toBe(50);
    // A cut that does not say it is a cut reads as the whole story.
    expect(tail.truncated).toBe(true);
  });

  it('does not read a large log into memory whole', () => {
    // 512 MB and an SD card. The tail is what anybody looks at.
    const data = tmp();
    const line = `${'x'.repeat(200)}\n`;
    writeFileSync(path.join(data, 'update', 'last.log'), line.repeat(4000)); // ~800 KB
    const tail = readUpdateLog(data, 10);
    expect(tail.lines).toHaveLength(10);
    expect(tail.total, 'only the tail was ever read').toBeLessThan(4000);
    expect(tail.truncated).toBe(true);
  });
});

describe('writing down what happened', () => {
  function recorder() {
    const rows: { kind: string; message: string; data?: unknown }[] = [];
    return {
      rows,
      activity: { record: async (row: never) => void rows.push(row) } as never,
      log: { warn: () => undefined } as never,
    };
  }

  it('records a finished update once, however often the hub restarts', async () => {
    // This runs on every boot. A home does not want "the hub updated" again
    // every time the power blinks for the rest of the year.
    const data = tmp();
    writeStatus(data, { state: 'succeeded', liveBuild: '0.1.0-a86c1dc-main' });
    const { rows, activity, log } = recorder();
    await recordFinishedUpdate(data, activity, log);
    await recordFinishedUpdate(data, activity, log);
    await recordFinishedUpdate(data, activity, log);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('hub.update');
    expect(rows[0]?.message).toContain('0.1.0-a86c1dc-main');
  });

  it('says a rollback left the hub running, not that it broke', async () => {
    const data = tmp();
    writeStatus(data, { state: 'rolled-back', liveBuild: '0.1.0-1590564-main', error: 'it would not start' });
    const { rows, activity, log } = recorder();
    await recordFinishedUpdate(data, activity, log);
    expect(rows[0]?.message).toContain('running again');
  });

  it('says nothing at all about a run still going', async () => {
    const data = tmp();
    writeStatus(data, { state: 'running', heartbeat: new Date().toISOString() });
    const { rows, activity, log } = recorder();
    await recordFinishedUpdate(data, activity, log);
    expect(rows).toHaveLength(0);
  });
});
