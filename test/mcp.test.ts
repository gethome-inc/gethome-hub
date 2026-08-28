import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { HubEventBus } from '../src/core/bus.js';
import { ActivityService } from '../src/core/activity.js';
import { PairingService } from '../src/core/pairing.js';
import { SettingsService } from '../src/core/settings.js';
import { DeviceRegistry } from '../src/core/registry.js';
import { FavoritesService } from '../src/core/favorites.js';
import { PermitJoinService } from '../src/core/permit-join.js';
import { AiRunLog } from '../src/core/ai-runs.js';
import { MappingLibrary } from '../src/ai/library.js';
import { McpTokenService } from '../src/mcp/tokens.js';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '../src/mcp/protocol.js';
import type { AdapterBus, ProtocolAdapter } from '../src/adapters/adapter.js';
import type { HubCommand } from '../src/schema/index.js';
import { bootedHome, loadedAccess, openTestDb, resetDb, startedHistory } from './helpers/db.js';

const handle = await openTestDb();
const log = pino({ level: 'silent' });

class FakeAdapter implements ProtocolAdapter {
  readonly id = 'mqtt' as const;
  bus: AdapterBus | null = null;
  executed: Array<{ externalId: string; endpointId: number; command: HubCommand }> = [];
  /** When set, `execute` reports the write as having failed on the device. */
  failWith: string | null = null;
  /**
   * When set, `execute` answers with a `stateChanged` for this endpoint rather
   * than staying silent — so a test can have the *wrong* gang of a two-gang
   * switch report while the commanded one says nothing.
   */
  reportOnEndpoint: number | null = null;
  async start(bus: AdapterBus) {
    this.bus = bus;
  }
  async stop() {}
  async execute(externalId: string, endpointId: number, command: HubCommand) {
    this.executed.push({ externalId, endpointId, command });
    if (this.failWith) {
      this.bus!.commandFailed('mqtt', externalId, {
        property: 'state',
        kind: 'unreachable',
        detail: this.failWith,
      });
    }
    if (this.reportOnEndpoint !== null) {
      this.bus!.stateChanged('mqtt', externalId, this.reportOnEndpoint, { onOff: true });
    }
  }
}

describe.skipIf(!handle)('MCP server', () => {
  const db = handle?.db!;
  let app: FastifyInstance;
  let adapter: FakeAdapter;
  let registry: DeviceRegistry;
  let events: HubEventBus;
  let settings: SettingsService;
  let mcpTokens: McpTokenService;
  let history: Awaited<ReturnType<typeof startedHistory>>;
  let activityLog: ActivityService;
  let dataDir: string;
  let ownerToken: string;
  let ownerId: string;
  let controlToken: string;
  let readOnlyToken: string;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  /** One JSON-RPC round trip over the header-authenticated endpoint. */
  const rpc = async (body: unknown, token = controlToken) =>
    app.inject({ method: 'POST', url: '/api/v1/mcp', headers: auth(token), payload: body as object });

  const call = async (name: string, args: Record<string, unknown> = {}, token = controlToken) => {
    const response = await rpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      token,
    );
    return response.json() as {
      result?: { content: Array<{ text: string }>; structuredContent?: any; isError?: boolean };
      error?: { code: number; message: string };
    };
  };

  beforeAll(async () => {
    await resetDb(db);
    dataDir = mkdtempSync(path.join(tmpdir(), 'gethome-mcp-'));
    events = new HubEventBus();
    const activity = new ActivityService(db, events);
    activityLog = activity;
    const access = await loadedAccess(db, events);
    const pairing = new PairingService(db, dataDir, log, access);
    await pairing.boot();
    adapter = new FakeAdapter();
    registry = new DeviceRegistry(db, events, activity, log);
    registry.registerAdapter(adapter);
    await registry.start();
    settings = new SettingsService(db, Buffer.alloc(32).toString('base64'));
    const favorites = new FavoritesService(db, events);
    await favorites.load();
    history = await startedHistory(db, events);
    mcpTokens = new McpTokenService(db);

    app = await buildServer({
      db,
      log,
      events,
      registry,
      favorites,
      access,
      pairing,
      mcpTokens,
      activity,
      history,
      settings,
      hubId: 'hub-mcp-test',
      home: await bootedHome(db, 'Test Home'),
      version: '0.1.0-test',
      dataDir,
      radioBudget: 'both',
      z2mDataDir: path.join(dataDir, 'zigbee2mqtt'),
      permitJoin: new PermitJoinService(undefined, log, () => {}),
      aiRuns: new AiRunLog(db, events),
      mappings: new MappingLibrary({ db, settings, registry, log }),
    });
    await app.ready();

    const claim = await app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      payload: {
        code: readFileSync(path.join(dataDir, 'pairing-code'), 'utf8').trim(),
        memberName: 'Georgy',
      },
    });
    const claimed = claim.json() as { token: string; member: { id: string } };
    ownerToken = claimed.token;
    ownerId = claimed.member.id;

    controlToken = (await mcpTokens.mint({ label: 'Claude Desktop', canControl: true, memberId: ownerId })).token;
    readOnlyToken = (await mcpTokens.mint({ label: 'Reader', canControl: false, memberId: ownerId })).token;

    await settings.setMcpEnabled(true);

    adapter.bus!.deviceUpserted({
      adapter: 'mqtt',
      externalId: 'lamp-1',
      vendor: 'Acme',
      model: 'L1',
      suggestedName: 'Desk lamp',
      endpoints: [
        { endpointId: 1, deviceKind: 'light', capabilities: ['onOff', 'level'], primary: 'onOff' },
      ],
    });
    adapter.bus!.deviceUpserted({
      adapter: 'mqtt',
      externalId: 'lamp-2',
      suggestedName: 'Desk lamp',
      endpoints: [{ endpointId: 1, deviceKind: 'light', capabilities: ['onOff'], primary: 'onOff' }],
    });
    // One device, two gangs — the shape that made a report from the endpoint
    // nobody touched read as confirmation of the one that was commanded.
    adapter.bus!.deviceUpserted({
      adapter: 'mqtt',
      externalId: 'switch-2gang',
      suggestedName: 'Hall switch',
      endpoints: [
        { endpointId: 1, deviceKind: 'wallSwitch', capabilities: ['onOff'], primary: 'onOff' },
        { endpointId: 2, deviceKind: 'wallSwitch', capabilities: ['onOff'], primary: 'onOff' },
      ],
    });
    // A radiator valve reports the room *and* its own head, which is the shape
    // that had two different temperatures writing to one key.
    adapter.bus!.deviceUpserted({
      adapter: 'mqtt',
      externalId: 'trv-1',
      suggestedName: 'Radiator valve',
      endpoints: [
        {
          endpointId: 1,
          deviceKind: 'climate',
          capabilities: ['thermostat', 'temperature'],
          primary: 'thermostat',
        },
      ],
    });
    await registry.flush();
    adapter.bus!.stateChanged('mqtt', 'lamp-1', 1, {
      onOff: true,
      level: { current: 200, min: 1, max: 254 },
    });
    adapter.bus!.stateChanged('mqtt', 'trv-1', 1, {
      thermostat: {
        localTemperatureCenti: 1980,
        occupiedHeatingSetpointCenti: 2100,
        heatSetpointMinCenti: 500,
        heatSetpointMaxCenti: 3000,
        coolSetpointMinCenti: 1600,
        coolSetpointMaxCenti: 3200,
        systemMode: 4,
      },
      sensors: { temperatureCenti: 2150 },
    });
    await registry.flush();
  });

  afterAll(async () => {
    await history.stop();
    await app.close();
    await handle?.close();
  });

  describe('transport', () => {
    it('answers initialize with the client’s version when it is one we speak', async () => {
      const response = await rpc({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {} },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { result: { protocolVersion: string; serverInfo: unknown } };
      expect(body.result.protocolVersion).toBe('2025-06-18');
      expect(body.result.serverInfo).toMatchObject({ name: 'gethome-hub' });
    });

    it('never advertises a revision whose dispatch this server does not implement', async () => {
      // `2026-07-28` removes the initialize handshake, makes every request
      // self-describing through `_meta` and *requires* `server/discover`. This
      // server implements the handshake and none of that, so naming it would
      // hand a modern client a version it would then act on — and every one of
      // its calls would come back -32601.
      expect(SUPPORTED_PROTOCOL_VERSIONS).not.toContain('2026-07-28');
      expect(LATEST_PROTOCOL_VERSION).toBe('2025-11-25');

      const discover = await rpc({ jsonrpc: '2.0', id: 1, method: 'server/discover' });
      expect((discover.json() as { error: { code: number } }).error.code).toBe(-32_601);
    });

    it('answers a client that sends no version at all with one it can honour', async () => {
      const response = await rpc({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { capabilities: {} },
      });
      const body = response.json() as { result: { protocolVersion: string } };
      expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(body.result.protocolVersion);
    });

    it('falls back to its own newest version for one it does not know', async () => {
      const response = await rpc({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '1999-01-01' },
      });
      const body = response.json() as { result: { protocolVersion: string } };
      expect(body.result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    });

    it('answers a notification with 202 and no body', async () => {
      const response = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
      expect(response.statusCode).toBe(202);
      expect(response.body).toBe('');
    });

    it('refuses a batch, which the spec dropped', async () => {
      const response = await rpc([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
      const body = response.json() as { error: { code: number } };
      expect(body.error.code).toBe(-32_600);
    });

    it('reports a parse error for a body that is not JSON', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/mcp',
        headers: { ...auth(controlToken), 'content-type': 'text/plain' },
        payload: 'not json at all',
      });
      const body = response.json() as { error: { code: number } };
      expect(body.error.code).toBe(-32_700);
    });

    it('answers an unknown method with method-not-found', async () => {
      const response = await rpc({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
      const body = response.json() as { error: { code: number } };
      expect(body.error.code).toBe(-32_601);
    });

    it('answers GET with 405 while still having the endpoint', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/mcp' });
      expect(response.statusCode).toBe(405);
      expect(response.headers['allow']).toBe('POST');
    });

    /**
     * Both verbs hide the same thing, or neither does.
     *
     * The GET used to answer 405 whether or not MCP was on, so a switched-off
     * hub said "no such thing" to a POST and "wrong verb for the thing" to a
     * GET — and the pair of answers says more than either one.
     */
    it('answers both verbs 404 while assistant access is switched off', async () => {
      await settings.setMcpEnabled(false);
      try {
        const get = await app.inject({ method: 'GET', url: '/api/v1/mcp' });
        expect(get.statusCode).toBe(404);

        const post = await app.inject({
          method: 'POST',
          url: '/api/v1/mcp',
          headers: auth(controlToken),
          payload: { jsonrpc: '2.0', id: 1, method: 'ping' },
        });
        expect(post.statusCode).toBe(404);
      } finally {
        await settings.setMcpEnabled(true);
      }
    });

    /**
     * The switch is cached, so this is what proves the cache is write-through
     * rather than timed: a hub turned off has to stop answering *now*, not
     * when some interval lapses.
     */
    it('stops and starts answering the moment the switch moves', async () => {
      await settings.setMcpEnabled(false);
      expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })).statusCode).toBe(404);
      await settings.setMcpEnabled(true);
      expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })).statusCode).toBe(200);
    });

    it('never advertises OAuth on a 401, so a bearer client does not fall back to it', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/v1/mcp', payload: {} });
      expect(response.statusCode).toBe(401);
      expect(response.headers['www-authenticate']).toBeUndefined();
    });

    it('accepts the token in the path, for clients that only take a URL', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/mcp/t/${controlToken}`,
        payload: { jsonrpc: '2.0', id: 1, method: 'ping' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ result: {} });
    });
  });

  describe('authentication', () => {
    it('refuses a member’s token — it is not an MCP credential', async () => {
      const response = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, ownerToken);
      expect(response.statusCode).toBe(401);
    });

    it('refuses an MCP token on an ordinary REST route', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/devices',
        headers: auth(controlToken),
      });
      expect(response.statusCode).toBe(401);
    });

    it('refuses a revoked token', async () => {
      const doomed = await mcpTokens.mint({ label: 'Temporary', canControl: false, memberId: ownerId });
      expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, doomed.token)).statusCode).toBe(200);
      await mcpTokens.revoke(doomed.id);
      expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, doomed.token)).statusCode).toBe(401);
    });

    it('answers 404 while the hub has MCP switched off, rather than confirming the feature', async () => {
      await settings.setMcpEnabled(false);
      const response = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' });
      expect(response.statusCode).toBe(404);
      await settings.setMcpEnabled(true);
    });
  });

  describe('tools/list', () => {
    it('publishes every tool with a JSON Schema and explicit annotations', async () => {
      const response = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const body = response.json() as {
        result: {
          tools: Array<{
            name: string;
            inputSchema: Record<string, unknown>;
            annotations: Record<string, boolean | string>;
          }>;
        };
      };
      const tools = body.result.tools;
      expect(tools.length).toBeGreaterThanOrEqual(7);

      for (const tool of tools) {
        expect(tool.inputSchema['type']).toBe('object');
        // Left unset, the spec's defaults are destructive-and-open-world, so a
        // host would prompt before answering "is the door locked?".
        expect(tool.annotations['readOnlyHint']).toBeTypeOf('boolean');
        expect(tool.annotations['destructiveHint']).toBe(false);
        expect(tool.annotations['openWorldHint']).toBe(false);
      }

      const control = tools.find((tool) => tool.name === 'control_device');
      expect(control?.annotations['readOnlyHint']).toBe(false);
      expect(tools.find((tool) => tool.name === 'get_home')?.annotations['readOnlyHint']).toBe(true);
    });
  });

  describe('reading the home', () => {
    it('describes the home', async () => {
      const answer = await call('get_home');
      expect(answer.result?.structuredContent).toMatchObject({ name: 'Test Home', deviceCount: 4 });
    });

    it('lists devices as one line each, never full state', async () => {
      const answer = await call('list_devices');
      const devices = answer.result?.structuredContent.devices as Array<Record<string, unknown>>;
      expect(devices).toHaveLength(4);
      expect(devices[0]).toHaveProperty('ref');
      expect(devices[0]).not.toHaveProperty('endpoints');
      expect(answer.result?.content[0]?.text).toContain('Desk lamp');
    });

    it('gives one device its whole picture, in ordinary units', async () => {
      const list = await call('list_devices', { search: 'Desk' });
      const ref = (list.result?.structuredContent.devices as Array<{ ref: string; id: string }>).find(
        (row) => row.id.startsWith(row.ref),
      )!.ref;

      const answer = await call('get_device', { device: ref });
      const detail = answer.result?.structuredContent as {
        endpoints: Array<{ readings: Record<string, unknown>; actions: string[] }>;
      };
      const readings = detail.endpoints[0]!.readings;
      // 200 of 1..254 is 79% — a level, not a percentage, on the wire.
      expect(readings['brightnessPercent']).toBe(79);
      expect(readings['on']).toBe(true);
      expect(detail.endpoints[0]!.actions).toContain('brightness');
    });

    it('refuses an ambiguous name and names the candidates instead of guessing', async () => {
      const answer = await call('get_device', { device: 'Desk lamp' });
      expect(answer.result?.isError).toBe(true);
      expect(answer.result?.content[0]?.text).toContain('matches 2 devices');
    });

    it('says so plainly when nothing matches', async () => {
      const answer = await call('get_device', { device: 'kettle' });
      expect(answer.result?.isError).toBe(true);
      expect(answer.result?.content[0]?.text).toContain('No device matches');
    });

    /**
     * A TRV reports the room *and* its own valve head — Z2M maps
     * `local_temperature` onto the thermostat and `temperature` onto the
     * sensors — and both used to be written to one `temperatureC`. The sensors
     * block runs second, so the thermostat's own reading was overwritten and
     * no key was left holding it, while the one-line state read
     * `21.5 °C · 19.8 °C` with nothing saying which was which.
     */
    it('keeps a thermostat’s own temperature apart from the room’s', async () => {
      const answer = await call('get_device', { device: 'Radiator valve' });
      const detail = answer.result?.structuredContent as {
        endpoints: Array<{ readings: Record<string, unknown> }>;
      };
      const readings = detail.endpoints[0]!.readings;
      expect(readings['thermostatTemperatureC']).toBe(19.8);
      expect(readings['temperatureC']).toBe(21.5);

      const list = await call('list_devices', { search: 'Radiator' });
      const line = (list.result?.structuredContent.devices as Array<{ state: string }>)[0]!.state;
      expect(line).toContain('thermostat 19.8 °C');
      expect(line).toContain('21.5 °C');
    });

    /**
     * `state` selects on the device's typed `onOff`, never on the sentence
     * `describeState` writes for a person.
     *
     * **This pins the rule rather than catching a bug**, and the distinction is
     * worth being honest about: the filter used to read
     * `row.state.startsWith('on')`, and on every input constructible today that
     * agrees with the typed value, because `describeState` happens to put
     * on/off first whenever it has one. Nothing was ever wrong on screen. What
     * was wrong is that a filter's answer depended on the word order of a
     * sentence written for humans — reorder those parts, or capitalise one, and
     * `list_devices({state:'on'})` starts answering "nothing" rather than
     * failing. So this test cannot go red for the old implementation, and is
     * here for the change that would otherwise go unnoticed.
     */
    it('selects on what the device reports, not on how its line reads', async () => {
      const on = await call('list_devices', { state: 'on' });
      const names = (on.result?.structuredContent.devices as Array<{ name: string }>).map(
        (row) => row.name,
      );
      // The lamp reported `onOff: true`. The valve reports a temperature and no
      // `onOff` at all, and the second lamp has reported nothing — neither is
      // "on", however its line happens to begin.
      expect(names).toContain('Desk lamp');
      expect(names).not.toContain('Radiator valve');
      expect(names).not.toContain('Hall switch');
    });
  });

  describe('control', () => {
    const lampRef = async () => {
      const list = await call('find_device', { query: 'Desk' });
      const rows = list.result?.structuredContent.devices as Array<{ id: string; ref: string }>;
      return rows[0]!.id;
    };

    it('refuses a read-only connection, and says why', async () => {
      const answer = await call(
        'control_device',
        { device: await lampRef(), action: { action: 'off' } },
        readOnlyToken,
      );
      expect(answer.result?.isError).toBe(true);
      expect(answer.result?.content[0]?.text).toContain('read-only');
      expect(adapter.executed).toHaveLength(0);
    });

    it('converts a percentage into the level the wire wants', async () => {
      adapter.executed = [];
      await call('control_device', {
        device: await lampRef(),
        action: { action: 'brightness', percent: 50 },
      });
      expect(adapter.executed[0]?.command).toMatchObject({ type: 'setLevel' });
      const level = (adapter.executed[0]!.command as { level: number }).level;
      expect(level).toBeGreaterThan(120);
      expect(level).toBeLessThan(135);
    });

    it('resolves a toggle against the state it already holds', async () => {
      adapter.executed = [];
      await call('control_device', { device: await lampRef(), action: { action: 'toggle' } });
      // The lamp is on, so a toggle is "off" — and saying which is what lets
      // the answer report what happened rather than that something happened.
      expect(adapter.executed[0]?.command).toMatchObject({ type: 'power', on: false });
    });

    /**
     * "Set the thermostat to heat at 21" is one natural call carrying two
     * fields, and a setpoint and a mode are two commands on the wire.
     *
     * This used to rank them — the setpoint won, the mode was dropped with
     * nothing recorded, and the answer still said "X is now …", so the
     * assistant reported the whole instruction as done while the device stayed
     * in whatever mode it was in. Silently doing half of what was asked is the
     * one outcome a model cannot recover from, because nothing tells it to.
     */
    it('refuses a thermostat action naming a setpoint and a mode together', async () => {
      adapter.executed = [];
      const answer = await call('control_device', {
        device: 'Radiator valve',
        action: { action: 'thermostat', heatingC: 21, mode: 'heat' },
      });
      expect(answer.result?.isError).toBe(true);
      expect(answer.result?.content[0]?.text).toContain('one of heatingC, coolingC or mode');
      // Nothing half-done: the refusal is instead of the command, not after it.
      expect(adapter.executed).toHaveLength(0);
    });

    it('still takes a thermostat setpoint, or a mode, on its own', async () => {
      adapter.executed = [];
      await call('control_device', {
        device: 'Radiator valve',
        action: { action: 'thermostat', heatingC: 21 },
      });
      expect(adapter.executed[0]?.command).toMatchObject({ type: 'setHeatingSetpoint', centi: 2100 });

      adapter.executed = [];
      await call('control_device', {
        device: 'Radiator valve',
        action: { action: 'thermostat', mode: 'heat' },
      });
      expect(adapter.executed[0]?.command).toMatchObject({ type: 'setSystemMode' });
    });

    it('reports the hub’s own sentence when a write does not reach the device', async () => {
      adapter.executed = [];
      adapter.failWith = 'Device did not respond';
      const answer = await call('control_device', {
        device: await lampRef(),
        action: { action: 'on' },
      });
      adapter.failWith = null;
      expect(answer.result?.isError).toBe(true);
      expect(answer.result?.content[0]?.text).toContain('Device did not respond');
    });

    it('does not read another endpoint’s report as confirmation', async () => {
      adapter.executed = [];
      // The command goes to endpoint 1; the *other* gang reports.
      adapter.reportOnEndpoint = 2;
      const answer = await call('control_device', {
        device: 'Hall switch',
        action: { action: 'on' },
      });
      adapter.reportOnEndpoint = null;

      expect(adapter.executed[0]?.endpointId).toBe(1);
      // Not confirmed: the endpoint that was commanded never answered.
      expect(answer.result?.content[0]?.text).toContain('has not reported back yet');
      expect(answer.result?.content[0]?.text).not.toContain('is now');
    });

    it('reads the commanded endpoint’s own report as confirmation', async () => {
      adapter.executed = [];
      adapter.reportOnEndpoint = 1;
      const answer = await call('control_device', {
        device: 'Hall switch',
        action: { action: 'on' },
      });
      adapter.reportOnEndpoint = null;

      expect(answer.result?.content[0]?.text).toContain('is now');
      expect(answer.result?.structuredContent.ok).toBe(true);
    });

    it('writes a line in the home’s history naming the assistant', async () => {
      await call('control_device', { device: await lampRef(), action: { action: 'on' } });
      const feed = await app.inject({
        method: 'GET',
        url: '/api/v1/activity',
        headers: auth(ownerToken),
      });
      const rows = feed.json() as Array<{ kind: string; message: string; data?: Record<string, unknown> }>;
      const row = rows.find((entry) => entry.data?.['via'] === 'mcp');
      expect(row?.kind).toBe('device.command');
      expect(row?.message).toContain('Claude Desktop');
    });
  });

  /**
   * The tool that had no test at all, which is how it kept the wire in the one
   * place the wire was never meant to reach a model.
   *
   * `HistoryService` stores readings in the hub's own scale, because a stored
   * average cannot be merged — so a temperature is `centiCelsius` and 2140 is
   * 21.4 °C. And a stored point's first element is an *offset into the emitted
   * grid*, an integer index, not a time: handing that over beside a `start` in
   * epoch ms makes the obvious reading, `start + offset`, wrong by a factor of
   * `bucketMs`.
   */
  describe('recorded readings', () => {
    beforeAll(async () => {
      adapter.bus!.stateChanged('mqtt', 'trv-1', 1, {
        sensors: { temperatureCenti: 2_140 },
      });
      await registry.flush();
      await history.flush();
    });

    it('answers in the unit a person uses, never the one the hub stores', async () => {
      const answer = await call('get_device_history', {
        device: 'Radiator valve',
        quantity: 'temperature',
        range: 'day',
      });
      const page = answer.result?.structuredContent as {
        unit: string;
        points: Array<{ at: string; min: number; max: number; avg: number }>;
      };
      expect(page.unit).toBe('°C');
      expect(page.points.length).toBeGreaterThan(0);
      // 2140 centi-°C, not two thousand degrees.
      // Room temperature, not two thousand degrees: the readings recorded are
      // 21.4-21.5 °C, stored as 2140-2150 centi-°C. A range rather than a
      // number because they share a five-minute bucket and the mean is
      // computed on read.
      const avg = page.points.at(-1)!.avg;
      expect(avg).toBeGreaterThan(21);
      expect(avg).toBeLessThan(22);
      expect(answer.result?.content[0]?.text).toContain('°C');
    });

    it('gives every point a real time, not a grid index', async () => {
      const answer = await call('get_device_history', {
        device: 'Radiator valve',
        quantity: 'temperature',
        range: 'day',
      });
      const page = answer.result?.structuredContent as {
        start: string;
        end: string;
        bucketMs: number;
        points: Array<{ at: string }>;
      };
      const start = Date.parse(page.start);
      const end = Date.parse(page.end);
      expect(Number.isNaN(start)).toBe(false);
      expect(Number.isNaN(end)).toBe(false);

      for (const point of page.points) {
        const at = Date.parse(point.at);
        expect(Number.isNaN(at)).toBe(false);
        expect(at).toBeGreaterThanOrEqual(start);
        expect(at).toBeLessThanOrEqual(end + page.bucketMs);
      }

      // The reading was recorded now, so the last point has to land near the
      // end of the window — which is exactly what a bare offset could not do.
      expect(end - Date.parse(page.points.at(-1)!.at)).toBeLessThan(2 * page.bucketMs);
    });

    it('says when the low and the high happened, not only what they were', async () => {
      const answer = await call('get_device_history', {
        device: 'Radiator valve',
        quantity: 'temperature',
        range: 'day',
      });
      expect(answer.result?.content[0]?.text).toMatch(/low .* at \d\d:\d\d/);
      expect(answer.result?.content[0]?.text).toMatch(/high .* at \d\d:\d\d/);
    });

    it('says plainly when nothing was recorded', async () => {
      const answer = await call('get_device_history', {
        device: 'Radiator valve',
        quantity: 'co2',
        range: 'day',
      });
      expect(answer.result?.content[0]?.text).toContain('no recorded co2');
      expect(answer.result?.structuredContent).toMatchObject({ points: [] });
    });
  });

  describe('management routes', () => {
    it('never returns a token’s plaintext after it is minted', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/settings/mcp',
        headers: auth(ownerToken),
      });
      const body = response.json() as { enabled: boolean; tokens: Array<Record<string, unknown>> };
      expect(body.enabled).toBe(true);
      expect(body.tokens.length).toBeGreaterThan(0);
      for (const token of body.tokens) expect(token).not.toHaveProperty('token');
    });

    it('hands the plaintext back exactly once, on the mint', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/settings/mcp/tokens',
        headers: auth(ownerToken),
        payload: { label: 'Codex', canControl: false },
      });
      expect(response.statusCode).toBe(201);
      const body = response.json() as { token: string; canControl: boolean };
      expect(body.token.startsWith('ghm_')).toBe(true);
      expect(body.canControl).toBe(false);
    });

    it('answers 404 revoking a token that is not there', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/v1/settings/mcp/tokens/does-not-exist',
        headers: auth(ownerToken),
      });
      expect(response.statusCode).toBe(404);
    });

    it('carries the capability on GET /hub without saying whether it is on', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/hub' });
      const body = response.json() as { mcp?: Record<string, unknown> };
      expect(body.mcp).toEqual({ available: true });
    });
  });

  /**
   * An assistant is the member who minted it reaching the home through another
   * door, and it must not get further through that one than they do.
   *
   * `activity.read` is the case, because it is the only permission an MCP tool
   * touches — and it *narrows* rather than refusing, which is exactly the shape
   * that goes wrong quietly: `get_activity` called `list(limit)` with no third
   * argument while the REST route had always passed one, so nothing 403'd and
   * nothing looked broken. The home just came back in full.
   */
  describe('a token carries its member’s permissions', () => {
    let narrowedToken: string;
    let narrowedId: string;

    beforeAll(async () => {
      // The reachable shape: a home that grants a role assistant access
      // without giving it the whole home's history.
      const role = await app.inject({
        method: 'POST',
        url: '/api/v1/roles',
        headers: auth(ownerToken),
        payload: { name: 'Assistant keeper', permissions: ['hub.mcp'] },
      });
      expect(role.statusCode).toBe(201);
      const { id: roleId } = role.json() as { id: string };

      const invite = await app.inject({
        method: 'POST',
        url: '/api/v1/invites',
        headers: auth(ownerToken),
        payload: { roleId },
      });
      expect(invite.statusCode).toBe(201);
      const { code } = invite.json() as { code: string };

      const joined = await app.inject({
        method: 'POST',
        url: '/api/v1/pair',
        payload: { code, memberName: 'Keeper' },
      });
      expect(joined.statusCode).toBe(200);
      const member = joined.json() as { token: string; member: { id: string } };
      narrowedId = member.member.id;

      // Minted through the route, by the member themselves, so the test walks
      // the path a home actually takes rather than reaching past the guard.
      const minted = await app.inject({
        method: 'POST',
        url: '/api/v1/settings/mcp/tokens',
        headers: auth(member.token),
        payload: { label: 'Keeper’s Claude', canControl: false },
      });
      expect(minted.statusCode).toBe(201);
      narrowedToken = (minted.json() as { token: string }).token;

      await activityLog.record({
        kind: 'note',
        message: 'The owner did something',
        memberId: ownerId,
      });
      await activityLog.record({
        kind: 'note',
        message: 'The keeper did something',
        memberId: narrowedId,
      });
    });

    it('narrows get_activity to the member’s own rows without activity.read', async () => {
      const answer = await call('get_activity', {}, narrowedToken);
      const messages = (answer.result!.structuredContent.entries as Array<{ message: string }>).map(
        (entry) => entry.message,
      );
      expect(messages).toContain('The keeper did something');
      expect(messages).not.toContain('The owner did something');
    });

    it('leaves the whole log to a member who has activity.read', async () => {
      // The owner is answered `true` without a stored set, which is what makes
      // this the other half rather than a restatement: a permission with only
      // a refusal test can be broken by denying everybody.
      const answer = await call('get_activity', {}, controlToken);
      const messages = (answer.result!.structuredContent.entries as Array<{ message: string }>).map(
        (entry) => entry.message,
      );
      expect(messages).toContain('The keeper did something');
      expect(messages).toContain('The owner did something');
    });
  });
});
