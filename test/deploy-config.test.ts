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

  /**
   * Pull a heredoc body out of the installer by its delimiter.
   *
   * Quoted or not: the broker drop-in became unquoted when it started naming
   * the password and ACL files it writes, and a helper that silently matched
   * neither would have turned "this config is wrong" into "this test cannot
   * find the config".
   */
  function heredoc(delimiter: string): string {
    const pattern = new RegExp(`<<'?${delimiter}'?\\n([\\s\\S]*?)\\n${delimiter}\\n`);
    const found = installer.match(pattern);
    expect(found, `heredoc ${delimiter} not found in install.sh`).not.toBeNull();
    return found![1]!;
  }

  /**
   * The broker config as it lands on a Pi: our drop-in and ACL with the
   * installer's own paths swapped for ones this test owns.
   */
  function brokerFiles(dir: string, port: number): { conf: string; acl: string } {
    const substitutions: Record<string, string> = {
      '${MQTT_PASSWD_FILE}': path.join(dir, 'gethome.passwd'),
      '${MQTT_ACL_FILE}': path.join(dir, 'gethome.acl'),
      '${MQTT_ENV}': '/etc/gethome/mqtt.env',
      '${MQTT_HUB_USER}': 'gethome-hub',
      '${MQTT_APP_USER}': 'gethome',
    };
    const substitute = (text: string): string =>
      Object.entries(substitutions).reduce((acc, [from, to]) => acc.split(from).join(to), text);
    return {
      conf: substitute(heredoc('MOSQ')).replace('listener 1883', `listener ${port}`),
      acl: substitute(heredoc('MOSQACL')),
    };
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
    // **The broker asks for a password.** It used to be `allow_anonymous true`,
    // which meant anybody on the home Wi-Fi could publish
    // `zigbee2mqtt/<device>/set` and work every light and lock in the house
    // without a hub token — the whole role table on port 8420 sitting next to
    // an open door on 1883.
    expect(dropIn).toContain('allow_anonymous false');
    expect(dropIn).toMatch(/^password_file /m);
    expect(dropIn).toMatch(/^acl_file /m);
    // The fallback is the *other* file, and it must stay a separate branch: a
    // hub whose installer could not set a password up has to keep working.
    expect(heredoc('MOSQ_OPEN')).toContain('allow_anonymous true');

    // Whatever else it grows, it must not repeat what Debian already sets.
    for (const duplicated of ['persistence_location', 'log_dest', 'pid_file']) {
      expect(dropIn, `${duplicated} is already set by the distribution config`)
        .not.toMatch(new RegExp(`^\\s*${duplicated}\\b`, 'm'));
    }

    if (!mosquittoBinary) return; // Proven above; the live parse needs the broker.

    const dir = mkdtempSync(path.join(tmpdir(), 'gethome-mosq-'));
    dirs.push(dir);
    mkdirSync(path.join(dir, 'conf.d'));
    const files = brokerFiles(dir, 1883);
    writeFileSync(path.join(dir, 'conf.d', 'gethome.conf'), files.conf + '\n');
    writeFileSync(path.join(dir, 'gethome.acl'), files.acl + '\n');
    writeFileSync(path.join(dir, 'gethome.passwd'), '');
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

  /**
   * **Never lock the hub out of its own broker.**
   *
   * Turning authentication on is three files that all have to land: the
   * password file, the ACL, and the drop-in that names them. mosquitto opens
   * the first two *after* dropping privileges to its own account, so a
   * root-owned 0600 password file is a broker that refuses to start —
   * "Error: Unable to open pwfile", port 1883 closed, Zigbee and every MQTT
   * device gone, on a hub that installed perfectly. Reproduced against
   * mosquitto 2.0.18.
   *
   * An open broker is a hole. A broker that will not start is a hub with no
   * radios at all, and this installer must never pick the second while trying
   * to fix the first — so every step that can fail has to clear `MQTT_SECURED`
   * and fall back, rather than leave the drop-in pointing at a file nobody can
   * read.
   */
  it('refuses to switch the broker to passwords unless every part of it landed', () => {
    const section = installer.slice(
      installer.indexOf('# ── Mosquitto ──'),
      installer.indexOf('# ── mDNS ──'),
    );
    expect(section).not.toBe('');

    // Nothing is written on the strength of `mosquitto_passwd` existing.
    expect(section).toMatch(/command -v mosquitto_passwd/);
    // The broker's own account has to be able to read both files, and failing
    // that is a reason to stay open rather than a warning to skip past.
    expect(section).toMatch(/chown root:mosquitto/);
    expect(section).toMatch(/chmod 0640/);
    // Three places can give up, and each has to clear the flag.
    expect(section.match(/MQTT_SECURED=""/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(section).toMatch(/MQTT_SECURED=1/);
    // The drop-in, the credentials file and the ACL are all behind it.
    expect(section).toMatch(/if \[\[ -n "\$MQTT_SECURED" \]\]; then/);

    // **The passwords are minted once and kept.** Rotating them on every run
    // would silently break every integration the owner had wired in, on every
    // update — and `gethome-hubctl update` is this script again.
    expect(section).toMatch(/mqtt_env_value MQTT_PASSWORD/);
    expect(section).toMatch(/mqtt_env_value MQTT_INTEGRATION_PASSWORD/);
    expect(section, 'an existing password has to survive a re-run')
      .toMatch(/\[\[ -n "\$MQTT_HUB_PASS" \]\] \|\| MQTT_HUB_PASS=/);

    // A stale credentials file beside an open broker is the other way round of
    // the same lockout: both services would send a password nobody is checking.
    expect(section).toMatch(/rm -f "\$MQTT_ENV"/);
  });

  /**
   * **The passwords are minted once, and a re-run must not touch them.**
   *
   * `gethome-hubctl update` is this script again, and so is every install the
   * owner re-runs — so a `gen_secret` on each pass would silently break every
   * board they had wired in, every time the hub updated, with no message
   * anywhere. Reading the installer cannot prove that; this runs its own two
   * functions against a file the test owns, the way the cgroup test runs
   * `enable_memory_cgroup`.
   */
  it('mints broker passwords once and reuses them on every later run', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gethome-cred-'));
    dirs.push(dir);

    /** One pass of the installer's credential block, in isolation. */
    const pass = (): { hub: string; app: string; wasOpen: string } => {
      const output = execFileSync(
        'bash',
        [
          '-c',
          `set -euo pipefail
           SUDO=""
           CONF_DIR="$2"
           MQTT_ENV="$CONF_DIR/mqtt.env"
           eval "$(sed -n '/^gen_secret() {/,/^}/p' "$1")"
           eval "$(sed -n '/^mqtt_env_value() {/,/^}/p' "$1")"
           MQTT_HUB_PASS="$(mqtt_env_value MQTT_PASSWORD)"
           MQTT_APP_PASS="$(mqtt_env_value MQTT_INTEGRATION_PASSWORD)"
           MQTT_WAS_OPEN=""
           [[ -z "$MQTT_HUB_PASS" && -f "$CONF_DIR/hub.env" ]] && MQTT_WAS_OPEN=1
           [[ -n "$MQTT_HUB_PASS" ]] || MQTT_HUB_PASS="$(gen_secret)"
           [[ -n "$MQTT_APP_PASS" ]] || MQTT_APP_PASS="$(gen_secret)"
           printf '%s %s %s\n' "$MQTT_HUB_PASS" "$MQTT_APP_PASS" "\${MQTT_WAS_OPEN:-no}"
           printf 'MQTT_PASSWORD=%s\nMQTT_INTEGRATION_PASSWORD=%s\n' \
             "$MQTT_HUB_PASS" "$MQTT_APP_PASS" > "$MQTT_ENV"`,
          'bash',
          path.join(repoRoot, 'deploy', 'install.sh'),
          dir,
        ],
        { encoding: 'utf8' },
      ).trim().split(' ');
      return { hub: output[0]!, app: output[1]!, wasOpen: output[2]! };
    };

    const first = pass();
    // 32 hex characters. Hex because this value also travels through a
    // `mqtt://user:pass@host` URL and gets pasted into ESP32 sketches, where a
    // `/` or a `+` would have to be percent-encoded by every reader.
    expect(first.hub).toMatch(/^[0-9a-f]{32}$/);
    expect(first.app).toMatch(/^[0-9a-f]{32}$/);
    expect(first.app, 'the two accounts must not share a password').not.toBe(first.hub);
    // A hub that did not exist before is not one whose integrations just broke.
    expect(first.wasOpen).toBe('no');

    const second = pass();
    expect(second.hub, 'an update must not rotate the broker password').toBe(first.hub);
    expect(second.app).toBe(first.app);

    // An existing hub whose broker had no password: new credentials, and the
    // one warning that says the owner's own boards have stopped publishing.
    rmSync(path.join(dir, 'mqtt.env'));
    writeFileSync(path.join(dir, 'hub.env'), 'PORT=8420\n');
    const upgraded = pass();
    expect(upgraded.wasOpen).toBe('1');
    expect(upgraded.hub).not.toBe(first.hub);
    // And it is said once, not on every run afterwards.
    expect(pass().wasOpen).toBe('no');
  });

  /**
   * The credentials reach both services through systemd, and never through
   * hub.env — which is written *only when it is absent*, so a new variable in
   * it would never reach a hub being upgraded. That is the same trap that makes
   * a `GETHOME_UPDATE=1` line there the wrong answer.
   */
  it('hands the broker credentials to both units, after hub.env', () => {
    const hubUnit = installer.slice(
      installer.indexOf('gethome-hubd.service >/dev/null <<UNIT'),
      installer.indexOf('gethome-zigbee2mqtt.service >/dev/null <<UNIT'),
    );
    const z2mUnit = installer.slice(
      installer.indexOf('gethome-zigbee2mqtt.service >/dev/null <<UNIT'),
      installer.indexOf('gethome-hubctl'),
    );

    for (const unit of [hubUnit, z2mUnit]) {
      expect(unit).not.toBe('');
      // Optional, with a leading dash: a hub whose installer could not set a
      // password up has no such file and must still start.
      expect(unit).toMatch(/^EnvironmentFile=-\$\{CONF_DIR\}\/mqtt\.env$/m);
    }

    // **Order is the rollback story.** `install.sh` puts the previous build
    // back when a new one fails its health check, and that build may predate
    // MQTT_USERNAME — but every build the hub has ever had reads MQTT_URL, and
    // a later EnvironmentFile is the one that wins.
    const hubEnvAt = hubUnit.indexOf('EnvironmentFile=${CONF_DIR}/hub.env');
    const mqttEnvAt = hubUnit.indexOf('EnvironmentFile=-${CONF_DIR}/mqtt.env');
    expect(hubEnvAt).toBeGreaterThan(-1);
    expect(mqttEnvAt, 'mqtt.env has to be read after hub.env').toBeGreaterThan(hubEnvAt);

    const credentials = heredoc('MQTTENV');
    expect(credentials).toMatch(/^MQTT_URL=mqtt:\/\/\$\{MQTT_HUB_USER\}:/m);
    expect(credentials).toMatch(/^MQTT_USERNAME=/m);
    expect(credentials).toMatch(/^MQTT_INTEGRATION_USERNAME=/m);
    // Zigbee2MQTT reads its own names for the same account — an override, never
    // an edit to configuration.yaml, which holds the network key.
    expect(credentials).toMatch(/^ZIGBEE2MQTT_CONFIG_MQTT_USER=/m);
    expect(credentials).toMatch(/^ZIGBEE2MQTT_CONFIG_MQTT_PASSWORD=/m);
    expect(installer, 'the file holds every password on this machine')
      .toMatch(/chmod 0600 "\$MQTT_ENV"/);
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

  /**
   * The two units behind "update my hub from the app".
   *
   * The hub writes a run id into its own data directory; `gethome-update.path`
   * notices and starts `gethome-update.service`, which is root. Three
   * properties of that pair are load-bearing and none of them is obvious from
   * reading the unit, so they are pinned here.
   */
  describe('the update units', () => {
    const updateService = installer.slice(
      installer.indexOf('gethome-update.service >/dev/null <<UNIT'),
      installer.indexOf('$SUDO touch "${DATA_DIR}/update/enabled"'),
    );
    const updatePath = installer.slice(
      installer.indexOf('gethome-update.path >/dev/null <<UNIT'),
      installer.indexOf('gethome-update.service >/dev/null <<UNIT'),
    );

    it('watches the file the hub actually writes', () => {
      expect(updatePath).toMatch(/^PathModified=\$\{DATA_DIR\}\/update\/request$/m);
      expect(updatePath).toMatch(/^Unit=gethome-update\.service$/m);
    });

    it('never runs the update service at boot', () => {
      // A [Install] section plus `systemctl enable` would update a hub every
      // time the machine came up, which nobody asked for — and the path unit
      // is the only thing that should ever start this.
      expect(updateService).not.toMatch(/^\[Install\]$/m);
      expect(installer).not.toMatch(/systemctl enable[^\n]*gethome-update\.service/);
      // The path unit is the half that *is* enabled.
      expect(installer).toMatch(/systemctl enable --now gethome-update\.path/);
    });

    it('is not ordered after the hub it restarts', () => {
      // The installer this runs restarts gethome-hubd half way through. A unit
      // ordered after the hub is a unit systemd may stop when the hub stops,
      // which would kill an update in the middle of writing /opt/gethome.
      expect(updateService).not.toMatch(/^After=gethome-hubd/m);
    });

    it('does not let systemd time the update out', () => {
      // A Type=oneshot otherwise gets 90 seconds. A real update is apt, a
      // bundle download, migrations onto an SD card and up to four minutes of
      // health check — and the likeliest place a timeout lands is after the
      // symlink has moved to the new build and before the check that would
      // have rolled it back, killing the only thing that could undo it.
      expect(updateService).toMatch(/^TimeoutStartSec=infinity$/m);
    });

    it('leaves the hub a directory it can write the request into', () => {
      // The hub is unprivileged; `mkdir -p` here plus the `chown -R` on the
      // next line is what makes POST /system/update able to write at all.
      expect(installer).toMatch(/mkdir -p "\$INSTALL_DIR" "\$DATA_DIR" "\$DATA_DIR\/update"/);
    });
  });

  /**
   * @@ROLLBACK@@ is what tells "the new build wouldn't start and the hub put
   * itself back" from "the hub is down". Both end in `fail()`, and after either
   * the `current` symlink points where it started, so nothing else can.
   */
  it('announces a rollback as its own marker', () => {
    const rollback = installer.indexOf("printf '@@ROLLBACK:%s@@");
    expect(rollback, '@@ROLLBACK@@ must be printed').toBeGreaterThan(0);
    const rollbackSection = installer.slice(rollback, rollback + 400);
    expect(rollbackSection, 'it belongs with the flip back, not with the failure text')
      .toContain('Rolling back to the build that was running before');
    expect(installer, 'and the header list is the contract').toContain('@@ROLLBACK:<build>@@');
  });

  it('keeps the installer step ids Studio mirrors', () => {
    // Renaming one of these silently breaks the app's install checklist —
    // `FirstBootMonitor.installSteps` and `PiInstallView.steps()` hard-code them.
    for (const step of ['system', 'runtime', 'download', 'zigbee', 'start', 'autostart', 'health']) {
      expect(installer, `@@STEP:${step}@@ is a cross-repo contract`)
        .toMatch(new RegExp(`\\bstep ${step}\\b`));
    }
  });

  /**
   * **The caps above were not in force on a single Raspberry Pi.**
   *
   * Raspberry Pi OS ships `cgroup_disable=memory` in `cmdline.txt`, so the
   * kernel has no memory controller to enforce them with. Observed on a
   * Zero 2 W: the units carried the right numbers, `systemctl show` read them
   * straight back, and `MemoryCurrent` was `[not set]` with no `memory.*` file
   * anywhere in the unit's cgroup.
   *
   * The fix edits the file that decides whether the board boots at all, so it
   * is worth more than a text match: this runs the installer's own function
   * against a `cmdline.txt` the test owns, exactly the way
   * `GETHOME_ZIGBEE_SCAN_DIR` lets the Zigbee tests stage a coordinator.
   */
  it('turns the memory cgroup back on without breaking the boot', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gethome-cmdline-'));
    dirs.push(dir);
    const controllers = path.join(dir, 'controllers');
    const cmdline = path.join(dir, 'cmdline.txt');

    /** Run `enable_memory_cgroup` out of install.sh against those two files. */
    const rewrite = (): string => {
      execFileSync(
        'bash',
        [
          '-c',
          `set -euo pipefail
           SUDO=""
           warn() { :; }
           eval "$(sed -n '/^memory_cgroup_live() {/,/^}/p' "$1")"
           eval "$(sed -n '/^enable_memory_cgroup() {/,/^}/p' "$1")"
           enable_memory_cgroup`,
          'bash',
          path.join(repoRoot, 'deploy', 'install.sh'),
        ],
        { env: { ...process.env, GETHOME_CGROUP_CONTROLLERS: controllers, GETHOME_CMDLINE: cmdline } },
      );
      return readFileSync(cmdline, 'utf8');
    };

    // Verbatim from the Zero 2 W this was found on, double space included.
    const original =
      'coherent_pool=1M 8250.nr_uarts=0 cgroup_disable=memory snd_bcm2835.enable_hdmi=1  ' +
      'console=ttyS0,115200 root=PARTUUID=7d25da7f-02 rootfstype=ext4 fsck.repair=yes rootwait quiet splash';

    writeFileSync(controllers, 'cpuset cpu io pids\n'); // no `memory` — the Pi's default
    writeFileSync(cmdline, `${original}\n`);

    const rewritten = rewrite();
    // **One line.** The firmware reads the first and ignores the rest, so a
    // stray newline silently drops every parameter after it.
    expect(rewritten.trimEnd()).not.toContain('\n');
    expect(rewritten).not.toContain('cgroup_disable=memory');
    expect(rewritten).toContain('cgroup_enable=memory');
    expect(rewritten).toContain('cgroup_memory=1');
    // Nothing else may be lost — this file is the difference between a Pi that
    // boots and one that has to be fixed in another machine.
    for (const kept of original.split(/\s+/).filter((p) => p && p !== 'cgroup_disable=memory')) {
      expect(rewritten, `${kept} was dropped from the kernel command line`).toContain(kept);
    }

    // Re-running the installer is the ordinary case: `gethome-hubctl update`
    // is this script again.
    expect(rewrite()).toBe(rewritten);

    // A command line with no `root=` is not one we understand, and a wrong
    // guess there is a Pi that doesn't come back. Leave it exactly as it was.
    const unfamiliar = 'quiet splash cgroup_disable=memory\n';
    writeFileSync(cmdline, unfamiliar);
    expect(rewrite()).toBe(unfamiliar);

    // Debian, Ubuntu, and a Pi that has already been through this: the
    // controller is live, so there is nothing to do and nothing to say.
    writeFileSync(controllers, 'cpuset cpu io memory pids\n');
    writeFileSync(cmdline, `${original}\n`);
    expect(rewrite()).toBe(`${original}\n`);
  });

  /**
   * `MemoryMax` was the whole of "Zigbee2MQTT should die before the hub does",
   * and it needs a cgroup controller the Pi disables. `oom_score_adj` needs
   * nothing, works from the first start, and says the same thing to the only
   * component that actually makes the choice.
   */
  it('lets the kernel pick Zigbee2MQTT first when the board runs out of memory', () => {
    const adjust = (unit: string): number => {
      const found = unit.match(/^OOMScoreAdjust=(-?\d+)$/m);
      expect(found, 'OOMScoreAdjust is what works without the memory cgroup').not.toBeNull();
      return Number(found![1]);
    };
    const hub = adjust(installer.slice(
      installer.indexOf('gethome-hubd.service >/dev/null <<UNIT'),
      installer.indexOf('gethome-zigbee2mqtt.service >/dev/null <<UNIT'),
    ));
    const z2m = adjust(installer.slice(
      installer.indexOf('gethome-zigbee2mqtt.service >/dev/null <<UNIT'),
      installer.indexOf('gethome-hubctl'),
    ));
    expect(hub, 'the optional process is the one that should be picked').toBeLessThan(z2m);
    // Not -1000: that exempts the hub from the OOM killer outright, so a hub
    // that is itself leaking takes the machine down instead of being restarted
    // into a working one.
    expect(hub).toBeGreaterThan(-1000);
  });

  /**
   * Raspberry Pi OS Trixie ships its own zram (`systemd-zram-setup@zram0`),
   * and this installer added a second one beside it — two 415 MB devices and
   * an 830 MB `SwapTotal` on a board with 415 MB of RAM, where the compressed
   * pages live in the very memory they are saving.
   *
   * The cause is the guard, not the intent: our unit is deliberately early
   * (`Before=swap.target`), so at the moment it asks "is a zram swap running?"
   * the system's own is configured but not yet on. The question has to be one
   * that can be answered at any point in the boot.
   */
  it('stands down from zram when the distribution already provides it', () => {
    expect(installer).toMatch(/^zram_provided_by_the_system\(\) \{/m);
    expect(installer, 'the installer has to consult it, not just define it')
      .toContain('zram_provided_by_the_system; then');

    const zram = heredoc('ZRAM');
    const configured = zram.indexOf('zram-generator.conf');
    const created = zram.indexOf('hot_add');
    expect(configured, 'the boot-time script must ask the same question').toBeGreaterThan(-1);
    expect(created, 'and ask it before it creates a device').toBeGreaterThan(configured);
    // The running-device check may stay as a second line of defence, but it
    // cannot be the first: being early is exactly what defeated it.
    expect(zram.slice(0, configured)).not.toContain('swapon --show');
  });

  /**
   * **A backtick in an unquoted heredoc is a command, not punctuation.**
   *
   * `<<'DELIM'` is literal; `<<DELIM` expands variables *and* runs command
   * substitution — which is what the unit heredocs need for `${CONF_DIR}`. A
   * markdown habit in a comment inside one of them put three lines of
   * "MemoryMax: command not found" into a real install log, in front of the
   * user, and silently emptied those words out of the file that was written.
   * Nothing failed: bash substitutes the empty output of a failed command and
   * carries on, so `set -e` and the ERR trap never saw it.
   */
  it('never puts a backtick in a heredoc bash will expand', () => {
    const opens = [...installer.matchAll(/<<(')?([A-Z][A-Z0-9_]*)\1?\n/g)];
    let checked = 0;
    for (const open of opens) {
      if (open[1] === "'") continue; // quoted: the body is literal
      const delimiter = open[2]!;
      const start = open.index! + open[0].length;
      const end = installer.indexOf(`\n${delimiter}\n`, start);
      expect(end, `heredoc ${delimiter} is never closed`).toBeGreaterThan(-1);
      checked += 1;
      // An escaped backtick is fine — hub.env carries one deliberately.
      expect(
        installer.slice(start, end).replace(/\\`/g, ''),
        `a backtick in the unquoted heredoc ${delimiter} runs as a command`,
      ).not.toContain('`');
    }
    expect(checked, 'found no unquoted heredocs at all — this scan is broken')
      .toBeGreaterThan(0);
  });

  /**
   * A desktop image is the largest single thing in the way on a 512 MB board —
   * measured at ~75 MB on a Zero 2 W with nothing plugged into its HDMI, which
   * is more than the hub's whole Matter adapter on the one board that has to
   * choose between radios. Switching somebody's desktop off is not the
   * installer's business; saying what it costs is.
   */
  it('says what a desktop image costs on a small board', () => {
    const small = installer.slice(installer.indexOf('# ── Memory headroom'));
    expect(small).toContain('graphical.target');
    expect(small, 'name the fix, don\'t just name the problem')
      .toContain('set-default multi-user.target');
  });
});
