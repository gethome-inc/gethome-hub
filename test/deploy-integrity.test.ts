import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The digest checks `deploy/install.sh` runs over the two things it downloads
 * and then executes: the hub bundle and the Node.js runtime under it.
 *
 * These run the installer's **real** functions rather than a copy of their
 * rules — `deploy/` has no type checker behind it, and the whole reason this
 * exists is that "the download is whatever TLS handed us" was invisible until
 * somebody went looking. The extraction idiom is the one `deploy-wifi.test.ts`
 * arrived at the hard way: the sed program is built into a variable first,
 * because written inline its braces sit inside a second level of double quotes
 * within a command substitution and bash 3.2 — which is what macOS ships, and
 * what most of this suite is written under — brace-expands them anyway.
 */

const INSTALLER = path.resolve(import.meta.dirname, '../deploy/install.sh');
const installer = readFileSync(INSTALLER, 'utf8');
const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gethome-integrity-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Run one of the installer's digest helpers against real files.
 *
 * `hashers` decides which hashing tools the function can find, which is the
 * only way to reach the "this machine cannot hash anything" branch — and that
 * branch is the difference between warning and refusing to install.
 */
function run(
  script: string,
  options: { hashers?: Array<'sha256sum' | 'shasum'> } = {},
): { stdout: string; code: number } {
  const hashers = options.hashers ?? ['sha256sum', 'shasum'];
  const hidden = (['sha256sum', 'shasum'] as const).filter((name) => !hashers.includes(name));
  // `sha256_of` asks `command -v`, so a tool is hidden by making that answer
  // no — not by shadowing it on the PATH with a stub, which would still be
  // *found*. Overriding the builtin is the only thing the function can see.
  // The probe below proves the override really bites; without it the
  // one-tool-only cases would pass on the tool that was never hidden.
  // One definition covering every hidden name, never one per name: a second
  // `command()` *replaces* the first, so the per-name form silently un-hid
  // everything but the last — which is how "no hasher at all" quietly became
  // "shasum is missing" and returned 0 instead of 3.
  const hide =
    hidden.length === 0
      ? ''
      : `command() { case "$2" in ${hidden.join('|')}) return 1 ;; esac; builtin command "$@"; }`;

  let code = 0;
  let stdout = '';
  try {
    stdout = execFileSync(
      'bash',
      [
        '-c',
        `set -uo pipefail
         for fn in sha256_of verify_sha256 digest_for; do
           prog="/^$fn() {/,/^}/p"
           eval "$(sed -n "$prog" "$1")"
         done
         ${hide}
         ${script}`,
        'bash',
        INSTALLER,
      ],
      { encoding: 'utf8', env: { ...process.env } },
    );
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    code = failure.status ?? 1;
    stdout = failure.stdout ?? '';
  }
  return { stdout: stdout.trim(), code };
}

describe('install.sh — verify_sha256', () => {
  it('matches a correct digest', () => {
    const dir = tmp();
    const file = path.join(dir, 'bundle.tar.gz');
    writeFileSync(file, 'the hub bundle');
    const result = run(`verify_sha256 "${file}" "${sha256('the hub bundle')}"; echo "rc=$?"`);
    expect(result.stdout).toBe('rc=0');
  });

  it('reports a mismatch as 1 — the one code that stops an install', () => {
    const dir = tmp();
    const file = path.join(dir, 'bundle.tar.gz');
    writeFileSync(file, 'a bundle somebody swapped');
    const result = run(`verify_sha256 "${file}" "${sha256('the hub bundle')}"; echo "rc=$?"`);
    expect(result.stdout).toBe('rc=1');
  });

  it('accepts an upper-case digest and surrounding whitespace', () => {
    const dir = tmp();
    const file = path.join(dir, 'bundle.tar.gz');
    writeFileSync(file, 'the hub bundle');
    const shouted = sha256('the hub bundle').toUpperCase();
    const result = run(`verify_sha256 "${file}" "  ${shouted}  "; echo "rc=$?"`);
    expect(result.stdout).toBe('rc=0');
  });

  /**
   * The codes above 1 are the whole reason there is more than one failure
   * code: an absent or malformed digest is not evidence that a file is wrong,
   * and must never be treated as though it were.
   */
  it('separates "no digest" from "wrong file"', () => {
    const dir = tmp();
    const file = path.join(dir, 'bundle.tar.gz');
    writeFileSync(file, 'the hub bundle');
    for (const expected of ['', '   ', 'not-a-digest', 'abc123', `${sha256('x')}extra`]) {
      const result = run(`verify_sha256 "${file}" "${expected}"; echo "rc=$?"`);
      expect(result.stdout, `digest ${JSON.stringify(expected)}`).toBe('rc=2');
    }
  });

  it('reports 3 when the machine has nothing to hash with', () => {
    const dir = tmp();
    const file = path.join(dir, 'bundle.tar.gz');
    writeFileSync(file, 'the hub bundle');
    const result = run(`verify_sha256 "${file}" "${sha256('the hub bundle')}"; echo "rc=$?"`, {
      hashers: [],
    });
    expect(result.stdout).toBe('rc=3');
  });

  /**
   * The probe that keeps the case below honest.
   *
   * If the override did not bite, "only shasum" would simply run `sha256sum`
   * and pass — a green test for a branch it never entered, which is the shape
   * `CLAUDE.md` names twice. So the harness is asked directly what the script
   * can see before anything is asserted about which tool was used.
   */
  it('really can hide a hashing tool from the script', () => {
    expect(run('command -v sha256sum >/dev/null 2>&1 && echo seen || echo hidden').stdout).toBe(
      'seen',
    );
    expect(
      run('command -v sha256sum >/dev/null 2>&1 && echo seen || echo hidden', {
        hashers: ['shasum'],
      }).stdout,
    ).toBe('hidden');
    // And hiding one must leave the other alone, or the case below proves
    // nothing in the other direction either.
    expect(
      run('command -v shasum >/dev/null 2>&1 && echo seen || echo hidden', {
        hashers: ['shasum'],
      }).stdout,
    ).toBe('seen');
  });

  it('works with either hashing tool on its own', () => {
    const dir = tmp();
    const file = path.join(dir, 'bundle.tar.gz');
    writeFileSync(file, 'the hub bundle');
    for (const only of [['sha256sum'], ['shasum']] as const) {
      const result = run(`verify_sha256 "${file}" "${sha256('the hub bundle')}"; echo "rc=$?"`, {
        hashers: [...only],
      });
      expect(result.stdout, only[0]).toBe('rc=0');
    }
  });
});

describe('install.sh — digest_for', () => {
  /** nodejs.org's SHASUMS256.txt, in the shape it is really published. */
  const listing = [
    `${'a'.repeat(64)}  node-v22.22.2-linux-arm64.tar.gz`,
    `${'b'.repeat(64)}  node-v22.22.2-linux-arm64.tar.xz`,
    `${'c'.repeat(64)}  node-v22.22.2-linux-x64.tar.xz`,
    `${'d'.repeat(64)}  node-v22.22.2-linux-arm64.tar.xz.asc`,
  ].join('\n');

  it('picks the line for exactly the file asked for', () => {
    const dir = tmp();
    const file = path.join(dir, 'SHASUMS256.txt');
    writeFileSync(file, `${listing}\n`);
    const result = run(`digest_for "${file}" "node-v22.22.2-linux-arm64.tar.xz"`);
    expect(result.stdout).toBe('b'.repeat(64));
  });

  /**
   * The anchoring that matters: `.tar.xz` is a prefix of `.tar.xz.asc`, and a
   * substring match would hand back the signature's digest for the tarball —
   * a mismatch on every install, which install.sh treats as fatal.
   */
  it('does not confuse a name with one that merely starts the same', () => {
    const dir = tmp();
    const file = path.join(dir, 'SHASUMS256.txt');
    writeFileSync(file, `${listing}\n`);
    const result = run(`digest_for "${file}" "node-v22.22.2-linux-x64.tar.xz"`);
    expect(result.stdout).toBe('c'.repeat(64));
  });

  it('answers with nothing for a file the listing does not mention', () => {
    const dir = tmp();
    const file = path.join(dir, 'SHASUMS256.txt');
    writeFileSync(file, `${listing}\n`);
    expect(run(`digest_for "${file}" "node-v99.0.0-linux-arm64.tar.xz"`).stdout).toBe('');
  });

  it('answers with nothing when the listing is not there at all', () => {
    expect(run(`digest_for "${path.join(tmp(), 'absent')}" "anything.tar.xz"`).stdout).toBe('');
  });

  /**
   * An empty answer has to flow into `verify_sha256` as "cannot check" rather
   * than "wrong", because a release published before checksums existed has no
   * listing and must still install.
   */
  it('feeds an absent digest through as code 2, not a mismatch', () => {
    const dir = tmp();
    const bundle = path.join(dir, 'bundle.tar.gz');
    writeFileSync(bundle, 'the hub bundle');
    const result = run(
      `expected="$(digest_for "${path.join(dir, 'absent')}" "x.tar.xz")"
       verify_sha256 "${bundle}" "$expected"; echo "rc=$?"`,
    );
    expect(result.stdout).toBe('rc=2');
  });
});

/**
 * The call sites, read out of the script.
 *
 * These are assertions about wiring rather than behaviour — the branches
 * themselves need a network — and the one that matters is which outcome calls
 * `fail`: a mismatch must stop, and everything else must not.
 */
describe('install.sh — how the outcomes are wired', () => {
  const bundleBlock = (() => {
    const start = installer.indexOf('BUNDLE_EXPECTED=');
    expect(start, 'the bundle is not checked against a digest').toBeGreaterThan(-1);
    return installer.slice(start, installer.indexOf('STAGING="$RELEASES_DIR/.incoming.$$"', start));
  })();

  const nodeBlock = (() => {
    const start = installer.indexOf('NODE_SHA_FILE=');
    expect(start, 'the Node.js download is not checked against a digest').toBeGreaterThan(-1);
    return installer.slice(start, installer.indexOf('$SUDO rm -rf "$NODE_DIR"', start));
  })();

  it('fetches the checksum published beside the bundle', () => {
    expect(bundleBlock).toContain('${BUNDLE_URL}.sha256');
  });

  it('fetches nodejs.org’s own SHASUMS256.txt', () => {
    expect(nodeBlock).toContain('SHASUMS256.txt');
  });

  /**
   * **Not verified is not installed, and there is one path through it.** Every
   * outcome but a match stops: a mismatch, a release with no digest beside it,
   * and a machine that cannot hash. The softer rule — warn when the digest is
   * merely missing, since that is not evidence of tampering — makes the check
   * trivial to walk past by deleting one file, and the only case it protects
   * is a branch whose bundle predates this, which one push rebuilds.
   */
  it('stops the install on every outcome but a match, in both places', () => {
    for (const [name, block] of [
      ['bundle', bundleBlock],
      ['node', nodeBlock],
    ] as const) {
      // Each branch of the case, sliced at its own label so a branch that
      // stopped calling `fail` cannot hide behind a neighbour that still does.
      for (const label of ['1)', '2)', '3)', '*)']) {
        const start = block.indexOf(label);
        expect(start, `${name}: no ${label} branch`).toBeGreaterThan(-1);
        const next = ['1)', '2)', '3)', '*)']
          .map((other) => block.indexOf(other, start + label.length))
          .filter((index) => index > -1);
        const end = next.length > 0 ? Math.min(...next) : block.length;
        expect(block.slice(start, end), `${name} ${label}`).toContain('fail ');
      }
      // And nothing in the whole block settles for a warning.
      expect(block, name).not.toContain('warn ');
    }
  });

  /**
   * A refusal must not fall through to the source build. Cloning from the same
   * origin with less checking is not an answer to "this download cannot be
   * trusted", and the hub is still running its previous build, untouched.
   */
  it('never treats an unverified bundle as a reason to build from source', () => {
    expect(bundleBlock.slice(bundleBlock.indexOf('1)'))).not.toContain('INSTALLED=');
  });

  /**
   * Each failure says which of the four it was, so nobody has to guess.
   *
   * Four rather than three because `*)` used to carry the no-hasher sentence
   * as its catch-all, and a status it had never considered arrived: a helper
   * defined inside a branch that had not run answered 127, and a Raspberry Pi
   * was told to install the coreutils it ships with. A verdict about the file
   * and a failure of the check itself are different news.
   */
  it('gives the four refusals four different sentences', () => {
    for (const [name, block] of [
      ['bundle', bundleBlock],
      ['node', nodeBlock],
    ] as const) {
      const sentences = [...block.matchAll(/fail "([^"]+)"/g)].map((match) => match[1]);
      expect(sentences.length, name).toBe(4);
      expect(new Set(sentences).size, `${name}: two refusals read the same`).toBe(4);
      // The ones a person can act on: a rebuild, a network, a missing package.
      expect(sentences.some((text) => /does not match/.test(text!)), name).toBe(true);
      expect(sentences.some((text) => /sha256sum|shasum/.test(text!)), name).toBe(true);
      // And the one they cannot: it names the status instead of guessing.
      expect(
        sentences.some((text) => /failed with status/.test(text!)),
        `${name}: an unexpected status must not borrow another verdict's sentence`,
      ).toBe(true);
    }

    // The no-hasher sentence belongs to rc 3 alone. Sliced from each branch's
    // own label so the catch-all cannot inherit it from its neighbour.
    for (const [name, block] of [
      ['bundle', bundleBlock],
      ['node', nodeBlock],
    ] as const) {
      const catchAll = block.slice(block.indexOf('*)'));
      expect(catchAll, `${name}: the catch-all still claims the machine cannot hash`)
        .not.toContain('neither sha256sum nor shasum');
    }
  });
});

/**
 * The half that is not about hashing at all.
 *
 * `install.sh` runs under `set -euo pipefail`, and `verify_sha256` reports its
 * verdict *through* its exit status — so every outcome but "matched" is a
 * non-zero return from a bare command, which `set -e` treats as the script
 * dying. Written the obvious way, a release with no `.sha256` beside it ended
 * the install instead of falling through to the warning: the exact
 * installed-but-unusable trap `deploy/CLAUDE.md` names, introduced by the code
 * meant to make installing safer.
 *
 * These run the real snippets under the real shell options, so the guard
 * cannot quietly come undone.
 */
describe('the digest checks survive `set -euo pipefail`', () => {
  /** Run a snippet with the installer's own shell options and helpers. */
  function underSetE(snippet: string): { stdout: string; code: number } {
    let code = 0;
    let stdout = '';
    try {
      stdout = execFileSync(
        'bash',
        [
          '-c',
          `set -euo pipefail
           for fn in sha256_of verify_sha256 digest_for; do
             prog="/^$fn() {/,/^}/p"
             eval "$(sed -n "$prog" "$1")"
           done
           ${snippet}
           echo "REACHED-THE-END"`,
          'bash',
          INSTALLER,
        ],
        { encoding: 'utf8' },
      );
    } catch (error) {
      const failure = error as { status?: number; stdout?: string };
      code = failure.status ?? 1;
      stdout = failure.stdout ?? '';
    }
    return { stdout: stdout.trim(), code };
  }

  it('keeps going when there is no digest to compare against', () => {
    const dir = tmp();
    const file = path.join(dir, 'bundle.tar.gz');
    writeFileSync(file, 'the hub bundle');
    const result = underSetE(
      `EXPECTED="$(digest_for "${path.join(dir, 'absent')}" "x.tar.xz" || true)"
       RC=0
       verify_sha256 "${file}" "$EXPECTED" || RC=$?
       echo "rc=$RC"`,
    );
    expect(result.stdout).toContain('rc=2');
    // The assertion the bug would have failed: the shell got past the check.
    expect(result.stdout).toContain('REACHED-THE-END');
    expect(result.code).toBe(0);
  });

  it('keeps going on a mismatch, so the case can choose to stop deliberately', () => {
    const dir = tmp();
    const file = path.join(dir, 'bundle.tar.gz');
    writeFileSync(file, 'a bundle somebody swapped');
    const result = underSetE(
      `RC=0
       verify_sha256 "${file}" "${sha256('the hub bundle')}" || RC=$?
       echo "rc=$RC"`,
    );
    expect(result.stdout).toContain('rc=1');
    expect(result.stdout).toContain('REACHED-THE-END');
  });

  /**
   * And the shape of the call sites themselves, because the snippets above
   * prove the idiom works and not that `install.sh` uses it. A bare call is
   * the bug; `|| VAR=$?` is the fix.
   */
  it('never calls verify_sha256 bare in install.sh', () => {
    const calls = installer
      .split('\n')
      .filter((line) => line.includes('verify_sha256 ') && !line.trimStart().startsWith('#'));
    expect(calls.length, 'the installer stopped verifying downloads').toBeGreaterThan(0);
    for (const call of calls) {
      expect(call, call.trim()).toMatch(/\|\|\s*\w+=\$\?/);
    }
  });

  it('guards every digest-reading command substitution', () => {
    for (const line of installer.split('\n')) {
      if (!line.includes('_EXPECTED="$(')) continue;
      expect(line, line.trim()).toContain('|| true');
    }
  });
});

describe('.github/workflows/bundle.yml', () => {
  const workflow = readFileSync(
    path.resolve(import.meta.dirname, '../.github/workflows/bundle.yml'),
    'utf8',
  );

  it('publishes a digest beside every tarball it builds', () => {
    expect(workflow).toContain('sha256sum "gethome-hub-${{ matrix.arch }}.tar.gz"');
    expect(workflow).toContain('out/*.tar.gz.sha256');
  });

  it('verifies its own digest before publishing it', () => {
    expect(workflow).toContain('sha256sum -c "gethome-hub-${{ matrix.arch }}.tar.gz.sha256"');
  });

  it('uploads the digest to the release, not only as a CI artifact', () => {
    expect(workflow).toContain('gh release upload "$tag" out/*.tar.gz out/*.tar.gz.sha256');
  });
});

/**
 * The half of this that the suite above cannot see.
 *
 * Every test in this file `eval`s the helpers out of `install.sh` before
 * running a snippet, which is the only way to exercise shell functions from
 * here — and it means the suite defines them itself, so it can never notice
 * that the *script* does not define them where it calls them. It didn't: the
 * three were written beside their first use, inside the `else` that downloads
 * Node, and a machine that already had Node 22 ran the bundle check against a
 * function that had never been declared. `command not found` is 127, the case
 * there read that as "this machine cannot hash", and a Raspberry Pi was told
 * to install the coreutils it ships with. Fresh installs were fine; every
 * update of an existing hub was not.
 *
 * So this asserts the shape rather than the behaviour: defined before both
 * callers, and at the top level rather than inside a branch that may not run.
 */
describe('install.sh — the digest helpers are reachable from every caller', () => {
  const script = readFileSync(INSTALLER, 'utf8');
  const lines = script.split('\n');
  const helpers = ['sha256_of', 'verify_sha256', 'digest_for'] as const;

  function definitionLine(name: string): number {
    const at = lines.findIndex((line) => line.startsWith(`${name}() {`));
    expect(at, `${name} is not defined at the top level of install.sh`).toBeGreaterThanOrEqual(0);
    return at;
  }

  /** Which line first *calls* the helper, ignoring its own definition. */
  function firstCallLine(name: string): number {
    const at = lines.findIndex(
      (line, n) => n !== definitionLine(name) && !line.trimStart().startsWith('#') && line.includes(`${name} `),
    );
    expect(at, `${name} is never called`).toBeGreaterThanOrEqual(0);
    return at;
  }

  /**
   * How many column-0 `if` blocks are still open above a line.
   *
   * Crude on purpose, and checked: the count balances to 0 over the whole
   * file, so heredocs and `case` bodies are not throwing it off. It read 1 for
   * all three helpers on the commit this test was written against.
   */
  function openBlocksAbove(line: number): number {
    let depth = 0;
    for (let n = 0; n < line; n += 1) {
      const text = lines[n]!;
      if (text.startsWith('if ') || text.startsWith('if[')) depth += 1;
      else if (text === 'fi') depth -= 1;
    }
    return depth;
  }

  it('counts blocks correctly enough to be trusted', () => {
    expect(openBlocksAbove(lines.length)).toBe(0);
  });

  it.each(helpers)('defines %s outside any conditional block', (name) => {
    expect(
      openBlocksAbove(definitionLine(name)),
      `${name} is defined inside an if/else — a machine that skips that branch calls an undefined function`,
    ).toBe(0);
  });

  it.each(helpers)('defines %s before anything calls it', (name) => {
    expect(definitionLine(name)).toBeLessThan(firstCallLine(name));
  });

});
