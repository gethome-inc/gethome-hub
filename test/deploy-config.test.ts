import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const installer = readFileSync(path.join(repoRoot, 'deploy', 'install.sh'), 'utf8');

const mosquittoBinary = ['/usr/sbin/mosquitto', '/usr/local/sbin/mosquitto', '/opt/homebrew/sbin/mosquitto']
  .find((candidate) => existsSync(candidate));

/**
 * `deploy/` has no type checker behind it, and the configuration it writes is
 * only exercised on a Raspberry Pi. These are the checks that can be made here.
 */
describe('deploy/install.sh', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  /** Pull a heredoc body out of the installer by its delimiter. */
  function heredoc(delimiter: string): string {
    const pattern = new RegExp(`<<'${delimiter}'\\n([\\s\\S]*?)\\n${delimiter}\\n`);
    const found = installer.match(pattern);
    expect(found, `heredoc ${delimiter} not found in install.sh`).not.toBeNull();
    return found![1]!;
  }

  /**
   * **The regression that cost a whole install round.**
   *
   * Our drop-in is included *after* the distribution's own mosquitto.conf,
   * which already sets `persistence` and `persistence_location`. Repeating a
   * string option there is not an override — mosquitto treats it as a fatal
   * config error and refuses to start, so the broker was down, port 1883 was
   * closed, and Zigbee could not work at all on a hub that had otherwise
   * installed perfectly.
   *
   * The failure was invisible because the installer discarded the reason. This
   * test is the cheap half of the fix: it parses our drop-in together with a
   * copy of Debian's config, exactly as mosquitto will on the Pi.
   */
  it('writes a mosquitto drop-in that loads alongside the distribution config', () => {
    const dropIn = heredoc('MOSQ');
    expect(dropIn).toContain('listener 1883');
    expect(dropIn).toContain('allow_anonymous true');

    // Whatever else it grows, it must not repeat what Debian already sets.
    for (const duplicated of ['persistence_location', 'log_dest', 'pid_file']) {
      expect(dropIn, `${duplicated} is already set by the distribution config`)
        .not.toMatch(new RegExp(`^\\s*${duplicated}\\b`, 'm'));
    }

    if (!mosquittoBinary) return; // Proven above; the live parse needs the broker.

    const dir = mkdtempSync(path.join(tmpdir(), 'gethome-mosq-'));
    dirs.push(dir);
    mkdirSync(path.join(dir, 'conf.d'));
    writeFileSync(path.join(dir, 'conf.d', 'gethome.conf'), dropIn + '\n');
    // Debian / Raspberry Pi OS ship exactly this.
    writeFileSync(
      path.join(dir, 'mosquitto.conf'),
      [
        'persistence true',
        `persistence_location ${dir}/`,
        `log_dest file ${dir}/mosquitto.log`,
        `include_dir ${dir}/conf.d`,
        '',
      ].join('\n'),
    );

    let output = '';
    try {
      // Parses the config and exits; `-h` never opens a socket, so this is safe
      // to run in CI next to whatever else is using 1883.
      output = execFileSync(mosquittoBinary, ['-c', path.join(dir, 'mosquitto.conf'), '-h'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    }
    expect(output).not.toMatch(/Duplicate .* value in configuration/i);
    expect(output).not.toMatch(/^\s*Error:/im);
  });

  it('refuses 32-bit systems by name, and only builds 64-bit bundles', () => {
    // Every supported board (Zero 2 W, 3, 4, 5) is 64-bit, and 32-bit has no
    // prebuilt SQLite binding. The installer and CI have to agree on that, or
    // a Pi is told to download something nobody publishes.
    expect(installer).toMatch(/armv7l\|armv8l\)/);
    expect(installer).toMatch(/64-bit operating system|64-bit system/);
    expect(installer).not.toMatch(/NODE_ARCH="linux-armv7l"/);

    const workflow = readFileSync(path.join(repoRoot, '.github/workflows/bundle.yml'), 'utf8');
    expect(workflow).toContain('linux-arm64');
    expect(workflow).toContain('linux-x64');
    expect(workflow).not.toContain('linux-armv7l');
  });

  /**
   * The Zero 2 W path, which cannot be reproduced on a build machine: these are
   * the values that decide whether the hub survives on 512 MB.
   *
   * `MemoryMax` on hubd is the one that has to stay gone. Measured, the hub is
   * 119 MB resident with Matter off and 178 MB with it on, and a hard cap near
   * that turns a busy minute into a kill — which is what a 260 MB ceiling was
   * doing during the install. Throttling with `MemoryHigh` slows the cgroup
   * down instead and lets the garbage collector catch up.
   */
  it('sizes a 512 MB board to throttle rather than kill, and budgets it one radio', () => {
    const small = installer.slice(
      installer.indexOf('if [[ "$RAM_MB" -gt 0 && "$RAM_MB" -le 1024 ]]'),
      installer.indexOf('# ── System packages'),
    );
    expect(small).not.toBe('');
    expect(small).toContain('HUB_MEM_HIGH="MemoryHigh=');
    expect(small, 'a hard cap on hubd is what caused the restarts').not.toMatch(/HUB_MEM_MAX=/);
    // Zigbee2MQTT keeps a hard cap: it is the optional process and should die
    // on its own rather than take the hub down with it.
    expect(small).toContain('Z2M_MEM_MAX="MemoryMax=');

    // One radio, not none. The installer used to switch Matter off here
    // outright, which was wrong whenever no coordinator was plugged in — the
    // board then ran neither radio. It now records the *budget* and lets
    // gethome-zigbee-detect spend it, since that is the only thing that knows
    // whether the stick is actually there.
    expect(small).toContain('RADIO_BUDGET=one');
    expect(small, 'the radio decision moved to the detector').not.toContain('MATTER_DEFAULT=');

    // --optimize-for-size is rejected by NODE_OPTIONS, so it can only reach
    // the hub through the unit's own command line.
    expect(small).toContain('--optimize-for-size');
    expect(
      installer.slice(installer.indexOf('ExecStart=${NODE_BIN}')),
      'the V8 flags have to be argv, not NODE_OPTIONS',
    ).toMatch(/ExecStart=\$\{NODE_BIN\} \$\{HUB_V8_FLAGS\}/);

    // And the unit must not carry a MemoryMax for hubd from anywhere else.
    const hubUnit = installer.slice(
      installer.indexOf('gethome-hubd.service >/dev/null <<UNIT'),
      installer.indexOf('gethome-zigbee2mqtt.service >/dev/null <<UNIT'),
    );
    expect(hubUnit).toContain('${HUB_MEM_HIGH}');
    // A directive, not the word — the comment above it explains why there
    // isn't one, and matching prose would make this test unfixable.
    expect(hubUnit).not.toMatch(/^\s*MemoryMax=/m);
  });

  /**
   * `StartLimitIntervalSec=` and `StartLimitBurst=` are [Unit] options —
   * systemd moved them there in v230 and answers the old [Service] placement
   * with "Unknown key 'StartLimitIntervalSec' in section [Service], ignoring".
   *
   * The cost is quiet twice over: a warning on every unit load, so the hub's
   * journal carried eight of them per install, and a restart rate limit that
   * silently does not exist — the thing meant to stop a broken hub from
   * hammering itself into an unreadable log was never in force.
   */
  it('puts the systemd restart limits in the section systemd reads', () => {
    const units = [
      installer.slice(
        installer.indexOf('gethome-hubd.service >/dev/null <<UNIT'),
        installer.indexOf('gethome-zigbee2mqtt.service >/dev/null <<UNIT'),
      ),
      installer.slice(
        installer.indexOf('gethome-zigbee2mqtt.service >/dev/null <<UNIT'),
        installer.indexOf('gethome-hubctl'),
      ),
    ];
    for (const unit of units) {
      expect(unit).not.toBe('');
      // Split on the section *header*, not the first mention of it: the
      // comment above these keys names `[Service]` while explaining why they
      // are not in it, and a bare indexOf finds the prose first.
      const service = unit.slice(unit.indexOf('\n[Service]\n'));
      for (const key of ['StartLimitIntervalSec', 'StartLimitBurst']) {
        expect(unit, `${key} must be set at all`).toMatch(new RegExp(`^${key}=`, 'm'));
        expect(service, `${key} in [Service] is ignored by systemd`)
          .not.toMatch(new RegExp(`^${key}=`, 'm'));
      }
    }
  });

  it('keeps the installer step ids Studio mirrors', () => {
    // Renaming one of these silently breaks the app's install checklist —
    // `FirstBootMonitor.installSteps` and `PiInstallView.steps()` hard-code them.
    for (const step of ['system', 'runtime', 'download', 'zigbee', 'start', 'autostart', 'health']) {
      expect(installer, `@@STEP:${step}@@ is a cross-repo contract`)
        .toMatch(new RegExp(`\\bstep ${step}\\b`));
    }
  });
});
