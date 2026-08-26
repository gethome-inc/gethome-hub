import path from 'node:path';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * The type checker's own coverage, pinned.
 *
 * `tsconfig.json` is the *build*: `src`-only, `rootDir: "src"`, which is what
 * keeps `dist/` flat. For a long time that was also the whole of
 * `npm run typecheck`, so nothing type-checked `test/` — a suite could build a
 * server with one of `ApiDeps`' required fields missing, compile clean on the
 * machine it was written on, and fail in CI as `TypeError: list.map is not a
 * function` from a route answering 500. It happened twice over the same field.
 *
 * `tsconfig.test.json` closes that, and this suite is what keeps it closed:
 * "typecheck covers the tests" was written down before and enforced by
 * nothing, which is exactly how it went missing.
 */

const root = path.resolve(import.meta.dirname, '..');

interface ShownConfig {
  compilerOptions: Record<string, unknown>;
  files?: string[];
}

/**
 * Resolve a config the way `tsc -p` does — JSONC, `extends`, include globs —
 * by asking the compiler itself. TypeScript 7 is the native port and ships no
 * JS API to do this with, and reimplementing the glob walk here would only
 * pin what this file believes rather than what `tsc` actually reads.
 */
function shownConfig(file: string): ShownConfig {
  const tsc = path.join(root, 'node_modules', '.bin', 'tsc');
  const out = execFileSync(tsc, ['--showConfig', '-p', file], { cwd: root, encoding: 'utf8' });
  return JSON.parse(out) as ShownConfig;
}

describe('the test suite is type-checked', () => {
  it('puts every suite in the program, not just src/', () => {
    const files = (shownConfig('tsconfig.test.json').files ?? []).map((file) =>
      file.replace(/^\.\//, ''),
    );
    // Not a spot check of one file: whatever is in `test/` has to be in here,
    // or a suite could be added to a directory the config never picked up.
    expect(files).toContain('src/api/server.ts');
    expect(files).toContain('test/roles.test.ts');
    expect(files).toContain('test/integration/mqtt-roundtrip.test.ts');
    expect(files.filter((file) => file.startsWith('test/')).length).toBeGreaterThan(20);
  }, 60_000);

  it('checks them at the same strictness as the hub itself', () => {
    // Widening `rootDir` was the only thing ever in the way. A second config
    // is also the easiest place to quietly buy silence with `strict: false`.
    const build = shownConfig('tsconfig.json').compilerOptions;
    const tests = shownConfig('tsconfig.test.json').compilerOptions;
    for (const flag of [
      'strict',
      'exactOptionalPropertyTypes',
      'noUncheckedIndexedAccess',
      'noImplicitOverride',
    ]) {
      expect(build[flag], flag).toBe(true);
      expect(tests[flag], flag).toBe(true);
    }
    expect(tests.noEmit).toBe(true);
  }, 60_000);

  it('is what `npm run typecheck` actually runs, in both halves', () => {
    // CI runs `npm run typecheck` and nothing else, so the two must not be
    // able to mean different things — a `typecheck:test` nobody calls is the
    // same gap with a config file in it.
    const scripts = (
      JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts['typecheck:test']).toContain('tsconfig.test.json');
    expect(scripts.typecheck).toContain('typecheck:test');
    // The build's own pass stays: only it enforces `rootDir`.
    expect(scripts.typecheck).toMatch(/^tsc --noEmit/);
  });
});
