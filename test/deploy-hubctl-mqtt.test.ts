import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(import.meta.dirname, '../deploy/gethome-hubctl');
const dirs: string[] = [];

/**
 * `gethome-hubctl mqtt --rotate` — the answer to "somebody who had the broker
 * password has left".
 *
 * It works by *removing* the credentials file and re-running the installer,
 * which mints new ones when it finds none. That makes the failure path the
 * whole story: mosquitto is still enforcing the old password file, so a
 * machine left with no `mqtt.env` is one where the next restart of hubd or
 * Zigbee2MQTT connects anonymously and is refused — Zigbee and MQTT down,
 * reached from the one command meant to fix things. It is the "dead broker"
 * outcome the installer's own fallbacks exist to avoid.
 *
 * Three outcomes and they cannot be told apart by exit status alone, so this
 * drives the real function against a staged directory with a stubbed
 * `cmd_update`, the way `deploy-update.test.ts` drives the runner.
 */
describe('gethome-hubctl mqtt --rotate', () => {
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  const OLD = 'MQTT_USERNAME=gethome-hub\nMQTT_PASSWORD=OLDPASS\n'
    + 'MQTT_INTEGRATION_USERNAME=gethome\nMQTT_INTEGRATION_PASSWORD=OLDAPP\n';
  const NEW = 'MQTT_USERNAME=gethome-hub\nMQTT_PASSWORD=NEWPASS\n'
    + 'MQTT_INTEGRATION_USERNAME=gethome\nMQTT_INTEGRATION_PASSWORD=NEWAPP\n';

  interface Outcome {
    output: string;
    ok: boolean;
    /** What `mqtt.env` holds afterwards, or nil when it is gone. */
    stored: string | undefined;
    /** Where it all happened, so a test can look for what was left behind. */
    conf: string;
  }

  /**
   * Run `cmd_mqtt` with `cmd_update` replaced by `update`.
   *
   * `existing` is what the machine starts with: the credentials file, the
   * set-aside copy an interrupted rotation leaves, or neither.
   */
  function rotate(options: {
    existing: Record<string, string>;
    update: string;
    args?: string;
  }): Outcome {
    const conf = mkdtempSync(path.join(tmpdir(), 'gethome-hubctl-'));
    dirs.push(conf);
    for (const [name, body] of Object.entries(options.existing)) {
      writeFileSync(path.join(conf, name), body);
    }
    let output = '';
    let ok = true;
    try {
      output = execFileSync(
        'bash',
        [
          '-c',
          `set -uo pipefail
           SUDO=""
           CONF_DIR="$2"
           die() { echo "gethome-hubctl: $*" >&2; exit 1; }
           mqtt_field() { sed -n "s/^$1=//p" "$CONF_DIR/mqtt.env" 2>/dev/null | head -n1; }
           ${options.update}
           eval "$(sed -n '/^cmd_mqtt() {/,/^}/p' "$1")"
           echo rotate | cmd_mqtt ${options.args ?? '--rotate'}`,
          'bash',
          SCRIPT,
          conf,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
      ok = false;
    }
    const file = path.join(conf, 'mqtt.env');
    return {
      output,
      ok,
      stored: existsSync(file) ? readFileSync(file, 'utf8') : undefined,
      conf,
    };
  }

  /**
   * **The one that used to lose the credentials.** The installer never reached
   * its own credential block, so the broker is still enforcing the old
   * password file — which means putting that file back is the only correct
   * outcome, and deleting it was a hub with no radios.
   */
  it('puts the old credentials back when the installer fails', () => {
    const result = rotate({
      existing: { 'mqtt.env': OLD },
      update: 'cmd_update() { return 1; }',
    });
    expect(result.ok, 'a rotation that did not happen has to fail loudly').toBe(false);
    expect(result.stored, 'the credentials must survive a failed rotation').toBe(OLD);
    expect(result.output).toContain('nothing was rotated');
    // And no second copy of the passwords left lying beside them under
    // another name once the restore has happened.
    expect(existsSync(path.join(result.conf, 'mqtt.env.rotating'))).toBe(false);
  });

  it('replaces them when the installer finishes', () => {
    const result = rotate({
      existing: { 'mqtt.env': OLD },
      update: `cmd_update() { printf '%s' '${NEW}' > "$CONF_DIR/mqtt.env"; return 0; }`,
    });
    expect(result.ok).toBe(true);
    expect(result.stored).toBe(NEW);
    expect(result.output).toContain('NEWAPP');
  });

  /**
   * The installer rotated and *then* failed — a health check that rolled the
   * build back, say. The new password file is already in force on the broker,
   * so restoring the old env would leave the machine holding credentials
   * nothing accepts. **The file being there is the authority, not the exit
   * status.**
   */
  it('keeps the new credentials when the installer rotated and then failed', () => {
    const result = rotate({
      existing: { 'mqtt.env': OLD },
      update: `cmd_update() { printf '%s' '${NEW}' > "$CONF_DIR/mqtt.env"; return 1; }`,
    });
    expect(result.stored).toBe(NEW);
    expect(result.output).toContain('the installer reported a problem');
    expect(existsSync(path.join(result.conf, 'mqtt.env.rotating'))).toBe(false);
  });

  /**
   * Ctrl-C between the two moves, or a reboot. The credentials are beside
   * their own name and the hub has none; the broker is still enforcing them,
   * so putting them back is always right.
   */
  it('recovers credentials an interrupted rotation left set aside', () => {
    const result = rotate({
      existing: { 'mqtt.env.rotating': OLD },
      update: 'cmd_update() { return 1; }',
      args: '',
    });
    expect(result.stored).toBe(OLD);
    expect(result.output).toContain('OLDAPP');
  });

  /** Nothing to rotate is a refusal, not a mint. */
  it('refuses to rotate a broker that has no password', () => {
    const result = rotate({
      existing: {},
      update: 'cmd_update() { return 0; }',
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('no password set');
  });
});
