import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { buildServer } from '../src/api/server.js';
import { HubEventBus } from '../src/core/bus.js';
import { ActivityService } from '../src/core/activity.js';
import { PairingService } from '../src/core/pairing.js';
import { SettingsService } from '../src/core/settings.js';
import { DeviceRegistry } from '../src/core/registry.js';
import { PermitJoinService } from '../src/core/permit-join.js';
import { AiRunLog } from '../src/core/ai-runs.js';
import { MappingLibrary } from '../src/ai/library.js';
import {
  bootedHome,
  loadedFavorites,
  openTestDb,
  loadedAccess,
  startedHistory,
} from './helpers/db.js';

/**
 * `zigbee.problem` on the wire.
 *
 * `diagnosis.ts` is unit-tested on its own, so what this covers is the part
 * that has actually broken before: the *wiring*. `z2mDataDir` reaching the
 * server, the gate that only reads the disk while Zigbee is down, and the field
 * surviving into the JSON. `tsconfig` type-checks only `src`, so a dep that
 * never arrives from a test harness is invisible to the compiler — it shows up
 * as a hub that quietly says nothing, which is also what a healthy hub does.
 *
 * Its own database handle rather than a block inside `api.test.ts`: that suite
 * closes the shared handle in `afterAll`, and anything appended after it runs
 * against a closed connection.
 */
const handle = await openTestDb();
const log = pino({ level: 'silent' });

afterAll(async () => {
  await handle?.close();
});

describe.skipIf(!handle)('why Zigbee is down, over HTTP', () => {
  const db = handle?.db!;

  /** Enough of a ZigbeeAdapter for `GET /hub`: the server reads `.connected`. */
  const fakeZigbee = (connected: boolean) =>
    // `NonNullable`, because `ApiDeps.zigbee` is optional: without it this
    // fake's own type carries `| undefined`, which `exactOptionalPropertyTypes`
    // then refuses at the call site for a hub that definitely has a radio.
    ({ connected }) as unknown as NonNullable<Parameters<typeof buildServer>[0]['zigbee']>;

  interface HubBody {
    zigbee?: { enabled: boolean; connected: boolean; problem?: { kind: string; summary: string } };
  }

  async function hubInfo(options: { connected: boolean; log?: string }): Promise<HubBody> {
    const dir = mkdtempSync(path.join(tmpdir(), 'gethome-z2m-api-'));
    const z2mDataDir = path.join(dir, 'zigbee2mqtt');
    if (options.log !== undefined) {
      const run = path.join(z2mDataDir, 'log', '2026-08-09.01-40-03');
      mkdirSync(run, { recursive: true });
      writeFileSync(path.join(run, 'log.log'), options.log);
    }
    const events = new HubEventBus();
    const access = await loadedAccess(db, events);
    const pairing = new PairingService(db, dir, log, access);
    await pairing.boot();
    const activity = new ActivityService(db, events);
    const registry = new DeviceRegistry(db, events, activity, log);
    const settings = new SettingsService(db, Buffer.alloc(32).toString('base64'));
    const server = await buildServer({
      db,
      log,
      events,
      registry,
      favorites: await loadedFavorites(db, events),
      access,
      pairing,
      activity,
      history: await startedHistory(db, events),
      settings,
      aiRuns: new AiRunLog(db, events),
      mappings: new MappingLibrary({ db, settings, registry, log }),
      hubId: 'hub-z2m',
      home: await bootedHome(db, 'Z2M Hub'),
      version: '0.1.0-test',
      dataDir: dir,
      radioBudget: 'one',
      z2mDataDir,
      zigbee: fakeZigbee(options.connected),
      permitJoin: new PermitJoinService(undefined, log, () => {}),
    });
    await server.ready();
    const body = (await server.inject({ method: 'GET', url: '/api/v1/hub' })).json() as HubBody;
    await server.close();
    return body;
  }

  /** Verbatim from a Zero 2 W with a factory-fresh SONOFF ZBDongle-E. */
  const FIRMWARE_LOG =
    '[2026-08-09 01:40:06] error: z2m: Error: Adapter EZSP protocol version (8) ' +
    'is not supported by Host [13-19].\n';

  it('carries the reason a coordinator is not talking', async () => {
    const info = await hubInfo({ connected: false, log: FIRMWARE_LOG });
    expect(info.zigbee?.problem?.kind).toBe('firmware-too-old');
    // A whole sentence, so an app that has never heard of this kind still says
    // something true rather than rendering a slug.
    expect(info.zigbee?.problem?.summary).toMatch(/too old/);
  });

  it('says nothing about a radio that is working', async () => {
    // The disk is never touched on a healthy hub — and a stale log from a run
    // that has since recovered must not resurface as a live complaint.
    const info = await hubInfo({ connected: true, log: FIRMWARE_LOG });
    expect(info.zigbee).toMatchObject({ enabled: true, connected: true });
    expect(info.zigbee?.problem).toBeUndefined();
  });

  it('stays quiet, not broken, when there is no Zigbee2MQTT at all', async () => {
    // `GET /hub` is public and is the installer's health check, so the one
    // thing this may never do is throw.
    const info = await hubInfo({ connected: false });
    expect(info.zigbee).toMatchObject({ enabled: true, connected: false });
    expect(info.zigbee?.problem).toBeUndefined();
  });
});
