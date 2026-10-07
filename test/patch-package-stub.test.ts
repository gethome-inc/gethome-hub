import path from 'node:path';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The stub that stands in for `patch-package`, and the premise it rests on.
 *
 * The Bluetooth stack under `@matter/nodejs-ble` lists `patch-package` in its
 * `dependencies`, and the only thing that ever calls it is the maintainers' own
 * `prebuildify-cross` script, which patches their cross-compiling tools before
 * a release. The real package still carried 53 others onto every hub, `braces`
 * among them, and when an advisory with no patched release landed on `braces`
 * the audit job failed every pull request. `overrides` swaps it for
 * `stubs/patch-package`, which is a `package.json` and nothing else.
 *
 * That is safe only while nothing on an installing machine runs it, and if a
 * release ever started to, nothing else would say so: these are *optional*
 * dependencies, and npm drops an optional package whose install script fails.
 * The hub would carry on starting, report `bluetoothReason: 'not-installed'`,
 * and be unable to pair a factory-new Wi-Fi accessory. This suite turns that
 * into a red pull request instead, Dependabot's included.
 */

const root = path.resolve(import.meta.dirname, '..');

/** Everything that declared the real one when the stub went in. */
const DEPENDENTS = [
  '@stoprocent/bleno',
  '@stoprocent/bluetooth-hci-socket',
  '@stoprocent/noble',
];

interface LockEntry {
  version?: string;
  resolved?: string;
  link?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function lockPackages(): Record<string, LockEntry> {
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, LockEntry>;
  };
  return lock.packages;
}

/** `node_modules/a/node_modules/@b/c` → `@b/c`. */
function nameOf(key: string): string {
  return key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
}

/** Every JavaScript file a package ships, not counting its own nested deps. */
function scriptsIn(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.(c|m)?js$/.test(file))
    .filter((file) => !file.split(path.sep).includes('node_modules'))
    .map((file) => path.join(dir, file));
}

describe('the patch-package stub', () => {
  it('is the only patch-package in the tree, wherever it is asked for', () => {
    const packages = lockPackages();
    // One entry, the stub. A real copy nested under a dependent would mean the
    // override missed it, and its 53 packages would be back on the hub.
    const copies = Object.keys(packages).filter((key) => nameOf(key) === 'patch-package');
    expect(copies).toEqual(['node_modules/patch-package']);
    expect(packages['node_modules/patch-package']?.resolved).toBe('file:stubs/patch-package');

    // A package that starts depending on it later is one nobody has checked
    // for whether it actually runs it, so it has to be named here first.
    const dependents = Object.entries(packages)
      .filter(([key]) => key !== '')
      .filter(([, entry]) => 'patch-package' in { ...entry.dependencies, ...entry.optionalDependencies })
      .map(([key]) => nameOf(key))
      .sort();
    expect(dependents).toEqual(DEPENDENTS);
  });

  it('is copied into node_modules, not linked', () => {
    // `.npmrc`'s `install-links=true` is what does this. The bundle ships
    // `node_modules` without `stubs/`, so a symlink would dangle on every Pi.
    const installed = path.join(root, 'node_modules', 'patch-package');
    expect(lstatSync(installed).isSymbolicLink()).toBe(false);
    const manifest = JSON.parse(readFileSync(path.join(installed, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(manifest.version).toBe('0.0.0-stub');
  });

  it.each(DEPENDENTS)('is never run or loaded by %s', (name) => {
    const dir = path.join(root, 'node_modules', name);
    // All three ship prebuilt binaries for Linux and macOS, so a missing one
    // is a failed install rather than a platform this suite should skip.
    expect(existsSync(dir), `${name} is not installed, so nothing here was checked`).toBe(true);

    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    for (const hook of ['preinstall', 'install', 'postinstall']) {
      expect(manifest.scripts?.[hook] ?? '', `${name}'s ${hook} script`).not.toContain(
        'patch-package',
      );
    }

    const files = scriptsIn(dir);
    expect(files.length).toBeGreaterThan(0);
    const mentions = files.filter((file) => readFileSync(file, 'utf8').includes('patch-package'));
    expect(mentions.map((file) => path.relative(root, file))).toEqual([]);
  });
});
