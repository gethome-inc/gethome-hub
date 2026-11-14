import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEVICE_ID_PATTERN } from '../src/adapters/mqtt/convention.js';
import { HubEventBus } from '../src/core/bus.js';
import {
  MAX_MQTT_DEVICE_ACCOUNTS,
  MQTT_ACCOUNT_ID,
  MqttDeviceAccounts,
  brokerPasswordHash,
  mqttAccountTopics,
  mqttDeviceAccountsAvailability,
  readMqttAccountsResult,
} from '../src/core/mqtt-device-accounts.js';
import { members, mqttDeviceAccounts } from '../src/db/schema.js';
import { openTestDb, resetDb } from './helpers/db.js';
import {
  accountsResult,
  brokerAccount,
  brokerMachine,
  passwdUsers,
  runAccountsScript,
  watchForAccountRequests,
  type BrokerMachine,
} from './helpers/mqtt-accounts.js';

/**
 * A broker account for each device — the hub's half and the root script's,
 * together.
 *
 * The service writes a list and the script reads it, so every test here that
 * makes or ends an account runs the real `deploy/mqtt-accounts.sh` on it: the
 * rule `test/deploy-wifi-networks.test.ts` keeps, that a format written on one
 * side and read on the other is tested as one thing. What the *broker* then
 * does with the two files is `test/deploy-mqtt-acl.test.ts`, which needs a
 * broker; nothing here does.
 */

const handle = await openTestDb();
const log = pino({ level: 'silent' });

const scratch: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gethome-mqttacct-'));
  scratch.push(dir);
  return dir;
};

afterAll(async () => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  await handle?.close();
});

const waitFor = async (label: string, check: () => boolean, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe('what an account is', () => {
  it('is named the way a device is on the MQTT convention', () => {
    // `core/` does not import an adapter, so the pattern is written out there;
    // this is what keeps the two from parting.
    expect(MQTT_ACCOUNT_ID.source).toBe(DEVICE_ID_PATTERN.source);
    expect(MQTT_ACCOUNT_ID.flags).toBe(DEVICE_ID_PATTERN.flags);
  });

  it('hashes a password into the line mosquitto keeps', () => {
    // RFC-style fixed vector: the same password and salt always give the same
    // line, and the line is the shape the root script accepts and no other.
    const salt = Buffer.from('000102030405060708090a0b', 'hex');
    const line = brokerPasswordHash('correct horse', salt);
    expect(line).toBe(brokerPasswordHash('correct horse', salt));
    expect(line).toMatch(/^\$7\$101\$AAECAwQFBgcICQoL\$[A-Za-z0-9+/]{86}==$/);
    expect(brokerPasswordHash('correct horse')).not.toBe(line);
  });

  it('reaches its own device’s topics, and its project’s when it has one', () => {
    expect(mqttAccountTopics('desk-light-x7k2q9', null)).toEqual([
      'gethome/device/desk-light-x7k2q9/#',
      'gethome/discovery/desk-light-x7k2q9/#',
    ]);
    expect(mqttAccountTopics('desk-light-x7k2q9', '9f3a11c2')).toEqual([
      'gethome/device/desk-light-x7k2q9/#',
      'gethome/discovery/desk-light-x7k2q9/#',
      'gethome/project/9f3a11c2/#',
    ]);
  });

  it('is offered only where the installer said this machine applies the list', () => {
    const dataDir = tmp();
    expect(mqttDeviceAccountsAvailability(dataDir)).toEqual({ available: false, reason: 'not-installed' });
    const m = brokerMachine(tmp, { data: dataDir });
    expect(mqttDeviceAccountsAvailability(m.data)).toEqual({ available: true });
  });
});

describe.skipIf(!handle)('the hub’s list, applied by the root script', () => {
  const db = handle?.db!;
  let m: BrokerMachine;
  let accounts: MqttDeviceAccounts;
  let events: HubEventBus;
  let stopWatching: (() => void) | undefined;
  let anna: { id: string; name: string };

  const service = (overrides: { applyWaitMs?: number; revokeSettleMs?: number } = {}) =>
    new MqttDeviceAccounts({
      db,
      dataDir: m.data,
      events,
      reserved: ['gethome-hub', 'gethome'],
      log,
      applyWaitMs: overrides.applyWaitMs ?? 5000,
      revokeSettleMs: overrides.revokeSettleMs ?? 0,
    });

  beforeEach(async () => {
    await resetDb(db);
    const [row] = await db.insert(members).values({ name: 'Anna', role: 'owner' }).returning();
    anna = { id: row!.id, name: row!.name };
    m = brokerMachine(tmp);
    events = new HubEventBus();
    accounts = service();
    stopWatching = watchForAccountRequests(m);
  });

  afterEach(() => {
    stopWatching?.();
    stopWatching = undefined;
    accounts.stop();
  });

  const aclOf = () => readFileSync(m.acl, 'utf8');
  const passwdOf = () => readFileSync(m.passwd, 'utf8');

  it('gives a device an account the broker’s files then hold, and keeps no password', async () => {
    const before = passwdOf();
    const outcome = await accounts.mint({ deviceId: 'desk-light-x7k2q9', member: anna });
    if (!outcome.ok) throw new Error(`refused: ${outcome.reason}`);

    expect(outcome.state).toBe('applied');
    expect(outcome.replaced).toBe(false);
    expect(outcome.password).toMatch(/^[0-9a-f]{32}$/);
    expect(outcome.account).toMatchObject({
      deviceId: 'desk-light-x7k2q9',
      projectKey: null,
      memberId: anna.id,
      memberName: 'Anna',
    });

    // The broker's own two lines are byte for byte what they were, and the
    // device's is added after them.
    expect(passwdOf().startsWith(before)).toBe(true);
    expect(passwdUsers(m)).toEqual(['gethome-hub', 'gethome', 'desk-light-x7k2q9']);

    // Nothing anywhere holds the password: not the table, not the list the
    // root script reads, not the broker's file.
    const [row] = await db.select().from(mqttDeviceAccounts);
    expect(row!.passwordHash).toMatch(/^\$7\$101\$/);
    for (const text of [
      JSON.stringify(row),
      readFileSync(path.join(m.data, 'mqtt-accounts', 'accounts'), 'utf8'),
      passwdOf(),
    ]) {
      expect(text).not.toContain(outcome.password);
    }
  });

  it('adds a project’s own topics for a device that names one, and for no other', async () => {
    await accounts.mint({ deviceId: 'plate-reader-ab12cd', projectKey: '9f3a11c2', member: anna });
    await accounts.mint({ deviceId: 'desk-light-x7k2q9', member: anna });

    const generated = aclOf().split('# gethome:device-accounts\n')[1] ?? '';
    expect(generated.trim().split('\n')).toEqual([
      'user plate-reader-ab12cd',
      'topic readwrite gethome/project/9f3a11c2/#',
    ]);
    // Everything install.sh wrote is still there, untouched, above the line.
    expect(aclOf()).toContain('user gethome-hub\ntopic readwrite #');
    expect(aclOf()).toContain('pattern readwrite gethome/device/%u/#');
  });

  it('replaces the password when the same device is set up again', async () => {
    const first = await accounts.mint({ deviceId: 'desk-light-x7k2q9', member: anna });
    const lineBefore = passwdOf().split('\n').find((line) => line.startsWith('desk-light-x7k2q9:'));
    const second = await accounts.mint({ deviceId: 'desk-light-x7k2q9', projectKey: 'k1', member: anna });
    if (!first.ok || !second.ok) throw new Error('refused');

    expect(second.replaced).toBe(true);
    expect(second.password).not.toBe(first.password);
    expect(passwdUsers(m)).toEqual(['gethome-hub', 'gethome', 'desk-light-x7k2q9']);
    const lineAfter = passwdOf().split('\n').find((line) => line.startsWith('desk-light-x7k2q9:'));
    expect(lineAfter).not.toBe(lineBefore);
    expect(await accounts.list()).toHaveLength(1);
    expect((await accounts.get('desk-light-x7k2q9'))?.projectKey).toBe('k1');
  });

  it('will not name a device after one of the broker’s own accounts', async () => {
    for (const deviceId of ['gethome-hub', 'gethome']) {
      expect(await accounts.mint({ deviceId, member: anna })).toEqual({ ok: false, reason: 'reserved' });
    }
    expect(await accounts.list()).toEqual([]);
    expect(passwdUsers(m)).toEqual(['gethome-hub', 'gethome']);
  });

  it('offers nothing on a machine whose installer never set this up', async () => {
    rmSync(path.join(m.data, 'mqtt-accounts', 'enabled'));
    expect(await accounts.mint({ deviceId: 'desk-light-x7k2q9', member: anna })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(await accounts.list()).toEqual([]);
  });

  it('stops at the number the root script would stop at', async () => {
    await db.insert(mqttDeviceAccounts).values(
      Array.from({ length: MAX_MQTT_DEVICE_ACCOUNTS }, (_, index) => ({
        deviceId: `board-${index}`,
        passwordHash: brokerPasswordHash('x'),
        memberId: anna.id,
        memberName: 'Anna',
      })),
    );
    expect(await accounts.mint({ deviceId: 'one-too-many', member: anna })).toEqual({
      ok: false,
      reason: 'limit',
    });
    // One that already holds an account can still be given a new password.
    const again = await accounts.mint({ deviceId: 'board-7', member: anna });
    expect(again.ok).toBe(true);
  });

  it('answers pending, and keeps the account, when nothing applied the list in time', async () => {
    stopWatching?.();
    stopWatching = undefined;
    accounts = service({ applyWaitMs: 150 });
    const outcome = await accounts.mint({ deviceId: 'desk-light-x7k2q9', member: anna });
    if (!outcome.ok) throw new Error('refused');
    expect(outcome.state).toBe('pending');
    expect(await accounts.list()).toHaveLength(1);
    // It is still on its way: the next run of the script lands it.
    expect(passwdUsers(m)).toEqual(['gethome-hub', 'gethome']);
    runAccountsScript(m);
    expect(passwdUsers(m)).toEqual(['gethome-hub', 'gethome', 'desk-light-x7k2q9']);
  });

  it('keeps nothing when the root script refuses the list', async () => {
    // A password file without the hub's own account is one the script will
    // not touch — so the account never reaches the broker, and must not be
    // left in the table claiming it did.
    writeFileSync(m.passwd, `gethome:${brokerPasswordHash('integration-secret')}\n`);
    const refused = await accounts.mint({ deviceId: 'desk-light-x7k2q9', member: anna });
    expect(refused).toMatchObject({ ok: false, reason: 'failed' });
    expect(await accounts.list()).toEqual([]);
    expect(passwdUsers(m)).toEqual(['gethome']);
  });

  it('puts the old account back when a replacement is refused', async () => {
    const first = await accounts.mint({ deviceId: 'desk-light-x7k2q9', projectKey: 'k1', member: anna });
    if (!first.ok) throw new Error('refused');
    const [kept] = await db.select().from(mqttDeviceAccounts);

    writeFileSync(m.passwd, `gethome:${brokerPasswordHash('integration-secret')}\n`);
    const refused = await accounts.mint({ deviceId: 'desk-light-x7k2q9', member: anna });
    expect(refused).toMatchObject({ ok: false, reason: 'failed' });
    const [after] = await db.select().from(mqttDeviceAccounts);
    expect(after).toEqual(kept);
  });

  it('takes an account away when asked, and says when there was none', async () => {
    await accounts.mint({ deviceId: 'desk-light-x7k2q9', projectKey: 'k1', member: anna });
    await accounts.mint({ deviceId: 'other-board-aa11bb', member: anna });

    expect(await accounts.revoke('desk-light-x7k2q9')).toEqual({ state: 'applied' });
    expect(passwdUsers(m)).toEqual(['gethome-hub', 'gethome', 'other-board-aa11bb']);
    expect(aclOf()).not.toContain('desk-light-x7k2q9');
    expect(await accounts.revoke('desk-light-x7k2q9')).toBeUndefined();
  });

  it('takes a device’s account away when the device leaves the home', async () => {
    await accounts.mint({ deviceId: 'desk-light-x7k2q9', member: anna });
    await accounts.mint({ deviceId: 'other-board-aa11bb', member: anna });

    // The registry's own event, as it emits it — and only an MQTT device is
    // named the way an account is.
    events.emit('deviceRemoved', 'hub-uuid-1', { adapter: 'zigbee', externalId: 'other-board-aa11bb' });
    events.emit('deviceRemoved', 'hub-uuid-2', { adapter: 'mqtt', externalId: 'desk-light-x7k2q9' });
    events.emit('deviceRemoved', 'hub-uuid-3');

    await waitFor('the removed device’s line to go', () => !passwdUsers(m).includes('desk-light-x7k2q9'));
    expect(passwdUsers(m)).toEqual(['gethome-hub', 'gethome', 'other-board-aa11bb']);
    expect((await accounts.list()).map((account) => account.deviceId)).toEqual(['other-board-aa11bb']);
  });

  it('leaves the removed device its connection for a moment, and the row none', async () => {
    // The row goes at once; the broker is told after the settle, so a board
    // that is listening hears it was removed before it is cut off.
    accounts.stop();
    accounts = service({ revokeSettleMs: 400 });
    await accounts.mint({ deviceId: 'desk-light-x7k2q9', member: anna });

    accounts.forgetDevice('desk-light-x7k2q9');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await accounts.list()).toEqual([]);
    expect(passwdUsers(m)).toContain('desk-light-x7k2q9');

    await waitFor('the broker’s file to follow', () => !passwdUsers(m).includes('desk-light-x7k2q9'));
  });

  it('keeps the name of whoever gave an account after they have left', async () => {
    await accounts.mint({ deviceId: 'desk-light-x7k2q9', member: anna });
    await db.delete(members);
    const [account] = await accounts.list();
    expect(account).toMatchObject({ deviceId: 'desk-light-x7k2q9', memberId: null, memberName: 'Anna' });
    // And the board keeps its account: it belongs to the home, not to Anna.
    expect(passwdUsers(m)).toContain('desk-light-x7k2q9');
  });

  describe('at start', () => {
    it('asks once on a hub that has never given an account, and not again', async () => {
      const request = path.join(m.data, 'mqtt-accounts', 'request');
      expect(existsSync(request)).toBe(false);
      await accounts.reconcile();
      await waitFor('the first answer', () => accountsResult(m).state === 'applied');
      const first = readFileSync(request, 'utf8');
      expect(passwdUsers(m)).toEqual(['gethome-hub', 'gethome']);

      await accounts.reconcile();
      await service().reconcile();
      expect(readFileSync(request, 'utf8')).toBe(first);
    });

    it('brings the broker back into line with the table', async () => {
      await accounts.mint({ deviceId: 'desk-light-x7k2q9', member: anna });
      await accounts.mint({ deviceId: 'other-board-aa11bb', member: anna });
      // A removal whose reload never ran: the row is gone, the hub stopped.
      stopWatching?.();
      await db.delete(mqttDeviceAccounts);
      expect(passwdUsers(m)).toHaveLength(4);

      stopWatching = watchForAccountRequests(m);
      await service().reconcile();
      await waitFor('the stale accounts to go', () => passwdUsers(m).length === 2);
    });

    it('asks again after the installer wrote the broker’s files afresh', async () => {
      await accounts.mint({ deviceId: 'desk-light-x7k2q9', member: anna });
      // What install.sh does on every update: the password file begins again,
      // and the hub's note of what was applied is taken away.
      writeFileSync(
        m.passwd,
        `gethome-hub:${brokerPasswordHash('hub-secret')}\ngethome:${brokerPasswordHash('integration-secret')}\n`,
      );
      rmSync(path.join(m.data, 'mqtt-accounts', 'result'));
      await service().reconcile();
      await waitFor('the device’s account to come back', () => passwdUsers(m).includes('desk-light-x7k2q9'));
    });

    it('does nothing at all where the installer never set this up', async () => {
      rmSync(path.join(m.data, 'mqtt-accounts', 'enabled'));
      await accounts.reconcile();
      expect(existsSync(path.join(m.data, 'mqtt-accounts', 'request'))).toBe(false);
    });
  });
});

/**
 * The root half on its own, asked the questions a hub that has gone wrong —
 * or been made to — would ask it. The list is the hub user's file and the
 * script is root, and a broker that reads a broken password file or ACL is a
 * home with no Zigbee and no MQTT, so each of these ends with the broker's own
 * two accounts exactly where they were.
 */
describe('deploy/mqtt-accounts.sh, given a list it should not trust', () => {
  const hash = brokerPasswordHash('device-secret');
  let m: BrokerMachine;
  let base: string;

  const writeList = (lines: string[], revision = '11111111-2222-3333-4444-555555555555') => {
    writeFileSync(
      path.join(m.data, 'mqtt-accounts', 'accounts'),
      `revision=${revision}\n${lines.join('\n')}\n`,
    );
  };

  beforeEach(() => {
    m = brokerMachine(tmp);
    base = readFileSync(m.passwd, 'utf8');
  });

  it('always exits 0, and writes its answer as the list’s own revision', () => {
    writeList([`account=desk-light-x7k2q9 - ${hash}`]);
    expect(runAccountsScript(m)).toBe(0);
    expect(accountsResult(m)).toMatchObject({
      id: '11111111-2222-3333-4444-555555555555',
      state: 'applied',
      accounts: '1',
    });
    expect(readMqttAccountsResult(m.data)).toMatchObject({ state: 'applied' });
  });

  it('never lets a line replace or shadow the broker’s own accounts', () => {
    writeList([
      `account=gethome-hub - ${hash}`,
      `account=gethome - ${hash}`,
      `account=desk-light-x7k2q9 - ${hash}`,
    ]);
    runAccountsScript(m);
    expect(readFileSync(m.passwd, 'utf8')).toBe(`${base}desk-light-x7k2q9:${hash}\n`);
  });

  it('leaves out every line that is not exactly a name, a key and a hash', () => {
    const good = `account=desk-light-x7k2q9 9f3a11c2 ${hash}`;
    writeList([
      'account=',
      `account=two words - ${hash}`,
      `account=slash/in/name - ${hash}`,
      `account=plus+name - ${hash}`,
      `account=hash#name - ${hash}`,
      `account=colon:name - ${hash}`,
      `account=${'x'.repeat(65)} - ${hash}`,
      `account=good-name bad/key ${hash}`,
      `account=good-name # ${hash}`,
      'account=good-name - not-a-hash',
      'account=good-name - $6$salt$hash',
      `account=good-name - ${hash}extra`,
      `account=good-name - ${hash.replace('$101$', '$0$')}`,
      `account=good-name - ${hash} trailing`,
      `user gethome-hub`,
      `topic readwrite #`,
      `pattern readwrite #`,
      good,
      // A second line for a name already taken changes nothing.
      `account=desk-light-x7k2q9 other ${brokerPasswordHash('second')}`,
    ]);
    runAccountsScript(m);

    expect(readFileSync(m.passwd, 'utf8')).toBe(`${base}desk-light-x7k2q9:${hash}\n`);
    const generated = readFileSync(m.acl, 'utf8').split('# gethome:device-accounts\n')[1] ?? '';
    expect(generated.trim().split('\n')).toEqual([
      'user desk-light-x7k2q9',
      'topic readwrite gethome/project/9f3a11c2/#',
    ]);
    // Only the words the installer's own part uses ever reach the ACL.
    for (const line of readFileSync(m.acl, 'utf8').split('\n')) {
      if (line === '' || line.startsWith('#')) continue;
      expect(line).toMatch(/^(user [A-Za-z0-9_-]+|topic (read|write|readwrite) \S+|pattern readwrite \S+)$/);
    }
  });

  it('touches nothing when the list is there and does not read as one', () => {
    writeList([`account=desk-light-x7k2q9 - ${hash}`]);
    runAccountsScript(m);
    const withDevice = readFileSync(m.passwd, 'utf8');

    // No revision line: a truncated or foreign file. Read as "no accounts" it
    // would take every device's account away — so it is not read at all.
    writeFileSync(path.join(m.data, 'mqtt-accounts', 'accounts'), '');
    runAccountsScript(m);
    expect(readFileSync(m.passwd, 'utf8')).toBe(withDevice);
    expect(accountsResult(m)).toMatchObject({ state: 'failed', error: 'unreadable' });
  });

  it('touches nothing when the hub’s own account is missing from the password file', () => {
    writeFileSync(m.passwd, `gethome:${brokerPasswordHash('integration-secret')}\n`);
    writeList([`account=desk-light-x7k2q9 - ${hash}`]);
    runAccountsScript(m);
    expect(passwdUsers(m)).toEqual(['gethome']);
    expect(accountsResult(m)).toMatchObject({ state: 'failed', error: 'no-hub-account' });
  });

  it('touches nothing when the ACL is one an older installer wrote', () => {
    const older = readFileSync(m.acl, 'utf8').replace('# gethome:device-accounts\n', '');
    writeFileSync(m.acl, older);
    writeList([`account=desk-light-x7k2q9 9f3a11c2 ${hash}`]);
    runAccountsScript(m);
    expect(readFileSync(m.acl, 'utf8')).toBe(older);
    expect(passwdUsers(m)).toEqual(['gethome-hub', 'gethome']);
    expect(accountsResult(m)).toMatchObject({ state: 'failed', error: 'no-acl' });
  });

  it('with no list at all, leaves the installer’s files exactly as they are', () => {
    const acl = readFileSync(m.acl, 'utf8');
    runAccountsScript(m);
    expect(readFileSync(m.passwd, 'utf8')).toBe(base);
    expect(readFileSync(m.acl, 'utf8')).toBe(acl);
    expect(accountsResult(m)).toMatchObject({ state: 'applied', accounts: '0' });
  });

  it('applies no more accounts than the hub would hold', () => {
    writeList(
      Array.from({ length: MAX_MQTT_DEVICE_ACCOUNTS + 20 }, (_, index) => `account=board-${index} - ${hash}`),
    );
    runAccountsScript(m);
    expect(passwdUsers(m)).toHaveLength(2 + MAX_MQTT_DEVICE_ACCOUNTS);
  });

  it('writes files the broker can read and nobody else can', () => {
    writeList([`account=desk-light-x7k2q9 9f3a11c2 ${hash}`]);
    runAccountsScript(m);
    // The broker account's own — its user, its primary group, 0600 — because
    // mosquitto checks both against the account it reads them as and warns,
    // at every reload, about any other. What the broker then says about them
    // is `test/deploy-mqtt-acl.test.ts`, which has one read them.
    const account = brokerAccount();
    for (const file of [m.passwd, m.acl]) {
      const stat = statSync(file);
      expect(stat.mode & 0o777, file).toBe(0o600);
      expect(stat.uid, file).toBe(account.uid);
      expect(stat.gid, file).toBe(account.gid);
    }
  });

  it('replaces what an older build left rather than keeping its owner and mode', () => {
    // An older build wrote `root:mosquitto` 0640, and a file edited in place
    // keeps whatever it had. Each rewrite is a new file renamed over the old,
    // so nothing of the old one's survives — shown here with a mode the broker
    // would warn about, which is what the suite can set without root.
    for (const file of [m.passwd, m.acl]) chmodSync(file, 0o644);
    writeList([`account=desk-light-x7k2q9 9f3a11c2 ${hash}`]);
    runAccountsScript(m);
    expect(accountsResult(m)).toMatchObject({ state: 'applied' });
    for (const file of [m.passwd, m.acl]) {
      expect(statSync(file).mode & 0o777, file).toBe(0o600);
      expect(statSync(file).uid, file).toBe(brokerAccount().uid);
    }
  });

  it('writes nothing for a broker account this machine does not have', () => {
    // On a hub that is `mosquitto`, and the installer checked it is there. A
    // name that is not an account cannot be handed a file, and a file the
    // broker cannot be handed is one it may not be able to read — so the
    // files are left exactly as they were and the run says so.
    const before = [readFileSync(m.passwd, 'utf8'), readFileSync(m.acl, 'utf8')];
    writeList([`account=desk-light-x7k2q9 9f3a11c2 ${hash}`]);
    runAccountsScript(m, [], { GETHOME_MQTT_USER: 'no-such-broker-account-x9' });
    expect([readFileSync(m.passwd, 'utf8'), readFileSync(m.acl, 'utf8')]).toEqual(before);
    expect(accountsResult(m)).toMatchObject({ state: 'failed', error: 'write' });
  });

  it('writes its answer as the hub’s account, never through a name the hub planted', () => {
    // The directory is the hub user's, so a name in it is whatever that
    // account made it. A result written by root through a planted link would
    // overwrite the link's target; written beside the name and renamed over
    // it, the link is replaced and its target is left alone.
    const target = path.join(tmp(), 'root-only');
    writeFileSync(target, 'do not overwrite\n');
    symlinkSync(target, path.join(m.data, 'mqtt-accounts', 'result'));
    writeList([`account=desk-light-x7k2q9 - ${hash}`]);
    runAccountsScript(m);
    expect(readFileSync(target, 'utf8')).toBe('do not overwrite\n');
    expect(accountsResult(m)).toMatchObject({ state: 'applied' });
  });

  it('answers for the list it read, whichever revision the request names', () => {
    // The path unit does not fire while the script runs, so before leaving it
    // looks at the request once more and goes round again if that names a
    // revision other than the one it applied. A request left naming an older
    // revision must not hold it there, or change what the answer is about.
    writeList([`account=desk-light-x7k2q9 - ${hash}`], 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    writeFileSync(path.join(m.data, 'mqtt-accounts', 'request'), 'id=00000000-0000-0000-0000-000000000000\n');
    expect(runAccountsScript(m)).toBe(0);
    expect(accountsResult(m)).toMatchObject({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', state: 'applied' });
    expect(passwdUsers(m)).toEqual(['gethome-hub', 'gethome', 'desk-light-x7k2q9']);
  });
});
