import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts: string[]) => readFileSync(path.join(repoRoot, ...parts), 'utf8');

const bundleWorkflow = read('.github', 'workflows', 'bundle.yml');
const mirrorWorkflow = read('.github', 'workflows', 'mirror.yml');
const installer = read('deploy', 'install.sh');
const hubctl = read('deploy', 'gethome-hubctl');

/** The one slug that is baked into things already in the world. */
const PUBLIC_REPO = 'gethome-inc/gethome-hub';

/**
 * The code is public; the work that produces it is not. Development happens in
 * a private repository and only `main` is mirrored out — `docs/release.md` is
 * canonical, and these are the parts of that split a test can hold still.
 *
 * None of it has a type checker behind it, and the failure modes are all quiet:
 * a leaked branch name is a release page nobody was watching, and a broken
 * mirror is a public repository that silently stops moving.
 */
describe('the private-development / public-release split', () => {
  describe('bundle.yml', () => {
    /**
     * **The privacy invariant.** This trigger used to be `branches: ["**"]`,
     * which published a prerelease *named after the branch*, with its head SHA
     * in the notes, on every push. In a public repository that announces every
     * feature branch before anything is released — so the branch list is now a
     * closed set: the release paths, plus `hw/**` as the deliberate, opt-in
     * escape hatch for a branch somebody wants on real hardware.
     */
    it('publishes from the release branches and the opt-in hardware ones only', () => {
      const push = bundleWorkflow.slice(
        bundleWorkflow.indexOf('  push:'),
        bundleWorkflow.indexOf('  workflow_dispatch:'),
      );
      expect(push).not.toBe('');
      expect(push).toMatch(/^\s*tags: \["v\*"\]$/m);

      const branches = push.match(/^\s*branches: \[(.+)\]$/m)?.[1];
      expect(branches, 'no branch list to check').toBeDefined();
      const patterns = branches!.split(',').map((entry) => entry.trim().replace(/^"|"$/g, ''));
      expect(patterns).not.toHaveLength(0);
      for (const pattern of patterns) {
        // Every pattern is either the release branch or inside the opt-in
        // namespace. A bare `*` or `**` is what this test exists to refuse.
        expect(pattern === 'main' || pattern.startsWith('hw/'), `'${pattern}' publishes branches nobody opted in`)
          .toBe(true);
      }
    });

    /**
     * Both repositories run this file. Without the guard, the private one would
     * build `main` and every `v*` tag as well — a private duplicate of the
     * release the mirror is about to trigger publicly, paid for in private
     * Actions minutes on two runners including arm64.
     */
    it('builds everything in the public repository and only dev branches in the private one', () => {
      const guard = bundleWorkflow.slice(
        bundleWorkflow.indexOf('    if: >-', bundleWorkflow.indexOf('  bundle:')),
        bundleWorkflow.indexOf('runs-on: ${{ matrix.runner }}'),
      );
      expect(guard).toContain(`github.repository == '${PUBLIC_REPO}'`);
      expect(guard).toContain("startsWith(github.ref, 'refs/heads/hw/')");
      expect(guard).toContain("github.event_name == 'workflow_dispatch'");
    });
  });

  describe('mirror.yml', () => {
    it('does nothing when it is running in the public repository', () => {
      expect(mirrorWorkflow).toMatch(
        new RegExp(`^\\s*if: github\\.repository != '${PUBLIC_REPO}'$`, 'm'),
      );
    });

    /**
     * A fast-forward, never a force. `bundle.yml` stamps
     * `<version>-<short sha>-<ref>` into VERSION, which names the release
     * directory on the Pi and becomes `build` in `GET /hub`; squashing or
     * rewriting on the way out would leave hubs in the field reporting commits
     * that exist in no public repository. A non-fast-forward push means the
     * public repository has something the private one doesn't, and failing the
     * job is the correct answer to that.
     */
    it('never force-pushes', () => {
      const pushes = mirrorWorkflow.split('\n').filter((line) => line.includes('git push'));
      expect(pushes.length).toBeGreaterThan(0);
      for (const line of pushes) {
        expect(line, 'the mirror must fast-forward or fail').not.toMatch(/--force|(?:^|\s)-f(?:\s|$)/);
      }
    });

    /**
     * `workflow_dispatch` can be run from any ref, and a dispatch from a
     * feature branch would otherwise publish that branch as public `main` —
     * the exact mistake this workflow exists to prevent.
     */
    it('refuses to mirror anything but main and v* tags', () => {
      expect(mirrorWorkflow).toContain('"${GITHUB_REF_NAME}" != "main"');
      expect(mirrorWorkflow).toContain('Refusing to mirror');
      expect(mirrorWorkflow).toMatch(/^concurrency:$/m);
    });
  });

  describe('deploy/install.sh', () => {
    /**
     * **The trap this exists to avoid.** A private release asset is not
     * reachable at `releases/download/<tag>/<asset>` at all — that URL 404s
     * however good the token is. It takes the API twice: the release, to turn
     * the asset's name into an id, then the asset with an octet-stream Accept
     * header, which is what makes the API answer with bytes instead of JSON.
     */
    it('fetches a private bundle through the release-asset API', () => {
      expect(installer).toContain('releases');
      expect(installer).toMatch(/\$\{api\}\/tags\/\$\{BUNDLE_TAG\}/);
      expect(installer).toMatch(/\$\{api\}\/assets\/\$\{asset_id\}/);
      expect(installer).toContain('Accept: application/octet-stream');
    });

    /**
     * The installer's output is streamed to GetHome Studio and kept in logs,
     * and the line above the fetch prints the URL it is about to request. So
     * the token travels in a header and nothing prints it.
     */
    it('keeps the token out of URLs and out of the log', () => {
      const mentions = installer
        .split('\n')
        .filter((line) => line.includes('INSTALL_TOKEN') && !line.trimStart().startsWith('#'));
      expect(mentions.length).toBeGreaterThan(0);
      for (const line of mentions) {
        expect(line, 'a printed token ends up in a log Studio keeps')
          .not.toMatch(/^\s*(say|warn|fail|echo|printf)\b/);
        expect(line, 'a token in a URL is a token in the log line that prints it')
          .not.toMatch(/https?:\/\/[^"'\s]*INSTALL_TOKEN/);
      }
    });

    /** A public install is unchanged by any of this: no flags, no credential. */
    it('defaults to the public repository', () => {
      expect(installer).toContain(`REPO_SLUG="\${GETHOME_INSTALL_REPO:-${PUBLIC_REPO}}"`);
      expect(installer).toContain('INSTALL_TOKEN="${GETHOME_INSTALL_TOKEN:-}"');
      // Derived after the parse loop, or `--repo` would reach the bundle URL
      // and not the clone fallback.
      expect(installer.indexOf('REPO_URL="https://github.com/${REPO_SLUG}.git"'))
        .toBeGreaterThan(installer.indexOf('--repo) REPO_SLUG='));
    });
  });

  describe('deploy/gethome-hubctl', () => {
    /**
     * `update` is deliberately the installer rather than a second copy of its
     * logic, so whatever reaches the hub has to reach install.sh too — a test
     * hub on an unreleased branch updates from the private repository or not at
     * all.
     */
    it('passes the repository and token through to the installer', () => {
      expect(hubctl).toContain(`REPO_SLUG="\${GETHOME_INSTALL_REPO:-${PUBLIC_REPO}}"`);
      expect(hubctl).toMatch(/install\.sh --branch "\$branch" --repo "\$repo" --token "\$token"/);
      expect(hubctl).toMatch(/install\.sh --branch "\$branch" --repo "\$repo"$/m);
    });
  });
});
