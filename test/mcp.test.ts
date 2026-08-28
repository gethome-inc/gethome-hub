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
    await registry.flush();
    adapter.bus!.stateChanged('mqtt', 'lamp-1', 1, {
      onOff: true,
      level: { current: 200, min: 1, max: 254 },
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
      expect(answer.result?.structuredContent).toMatchObject({ name: 'Test Home', deviceCount: 3 });
    });

    it('lists devices as one line each, never full state', async () => {
      const answer = await call('list_devices');
      const devices = answer.result?.structuredContent.devices as Array<Record<string, unknown>>;
      expect(devices).toHaveLength(3);
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
});
