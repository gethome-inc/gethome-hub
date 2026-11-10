import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { eq } from 'drizzle-orm';
import { DeviceRegistry } from '../src/core/registry.js';
import { HubEventBus } from '../src/core/bus.js';
import { ActivityService } from '../src/core/activity.js';
import type { AdapterBus, AdapterDeviceDescriptor, ProtocolAdapter } from '../src/adapters/adapter.js';
import { devices, rooms } from '../src/db/schema.js';
import {
  acceptablePlainName,
  plainNameFor,
  suggestNames,
  uniqueName,
} from '../src/core/device-names.js';
import { deviceWire } from '../src/api/dto.js';
import { mappingDescriptorSchema } from '../src/ai/descriptor.js';
import { interpret } from '../src/ai/mapper.js';
import { openTestDb, resetDb } from './helpers/db.js';

/**
 * What a device is called when nobody has called it anything — and the one
 * promise underneath: a name a person gave is never replaced.
 */

const sensor = (capabilities: ('temperature' | 'humidity' | 'occupancy' | 'contact' | 'battery')[]) => ({
  endpoints: [{ deviceKind: 'sensor' as const, capabilities }],
});

describe('a plain name for what a device is', () => {
  it('names a sensor after what it senses', () => {
    expect(plainNameFor(sensor(['temperature', 'humidity', 'battery']))).toBe('Climate sensor');
    expect(plainNameFor(sensor(['occupancy', 'battery']))).toBe('Motion sensor');
    expect(plainNameFor(sensor(['contact']))).toBe('Door sensor');
    expect(plainNameFor(sensor(['temperature']))).toBe('Temperature sensor');
  });

  it('names everything else after its kind, in the word people use', () => {
    expect(plainNameFor({ endpoints: [{ deviceKind: 'outlet', capabilities: ['onOff', 'electricalPower'] }] })).toBe('Plug');
    expect(plainNameFor({ endpoints: [{ deviceKind: 'shade', capabilities: ['windowCovering'] }] })).toBe('Blind');
    // A plug that also reports a temperature is a plug.
    expect(
      plainNameFor({
        endpoints: [
          { deviceKind: 'sensor', capabilities: ['temperature'] },
          { deviceKind: 'outlet', capabilities: ['onOff'] },
        ],
      }),
    ).toBe('Plug');
  });

  it('reads the device’s own description only when its kind says nothing', () => {
    expect(plainNameFor({ ...sensor(['battery']), hint: 'Water leak detector' })).toBe('Leak sensor');
    expect(plainNameFor({ ...sensor(['battery']), hint: 'TS0601' })).toBe('Sensor');
    // …and never over what the capabilities already say.
    expect(plainNameFor({ ...sensor(['occupancy']), hint: 'Water leak detector' })).toBe('Motion sensor');
    expect(plainNameFor({ endpoints: [] })).toBe('Device');
  });

  it('makes a second one differ by number, whatever its case', () => {
    expect(uniqueName('Plug', [])).toBe('Plug');
    expect(uniqueName('Plug', ['plug'])).toBe('Plug 2');
    expect(uniqueName('Plug', ['Plug', 'Plug 2'])).toBe('Plug 3');
  });

  it('takes a name from recognition only when it is one', () => {
    expect(acceptablePlainName(' Climate  sensor ')).toBe('Climate sensor');
    expect(acceptablePlainName('Aqara WSDCGQ11LM temperature and humidity sensor')).toBeNull();
    expect(acceptablePlainName('Sensor 0x54ef44100047c1bf')).toBeNull();
    expect(acceptablePlainName('TS0601')).toBeNull();
    expect(acceptablePlainName(undefined)).toBeNull();
  });
});

describe('names to offer', () => {
  it('offers the room’s, then recognition’s, then the plain one — each unique', () => {
    expect(
      suggestNames({
        shape: sensor(['temperature', 'humidity']),
        recognised: 'Thermometer',
        room: 'Bedroom',
        taken: ['Climate sensor'],
      }),
    ).toEqual(['Bedroom thermometer', 'Thermometer', 'Climate sensor 2']);
  });

  it('offers one name when that is all there is to say', () => {
    expect(suggestNames({ shape: sensor(['occupancy']), taken: [] })).toEqual(['Motion sensor']);
    expect(suggestNames({ shape: sensor(['occupancy']), recognised: 'Motion sensor', taken: [] })).toEqual([
      'Motion sensor',
    ]);
  });
});

describe('a descriptor’s name', () => {
  it('is optional, and reaches the adapter when given', () => {
    const endpoint = {
      endpointId: 1,
      deviceKind: 'sensor',
      capabilities: ['temperature'],
      primary: 'temperature',
      stateRules: [{ property: 'temperature', to: 'sensors.temperatureCenti', transform: { kind: 'celsiusToCenti' } }],
    };
    const named = mappingDescriptorSchema.parse({ name: 'Climate sensor', endpoints: [endpoint] });
    expect(interpret(named, 'ai').name).toBe('Climate sensor');
    const bare = mappingDescriptorSchema.parse({ endpoints: [endpoint] });
    expect(interpret(bare, 'ai').name).toBeUndefined();
  });
});

const handle = await openTestDb();
const log = pino({ level: 'silent' });

class FakeAdapter implements ProtocolAdapter {
  readonly id = 'zigbee' as const;
  bus: AdapterBus | null = null;
  async start(bus: AdapterBus): Promise<void> {
    this.bus = bus;
  }
  async stop(): Promise<void> {}
  async execute(): Promise<void> {}
}

/** A climate sensor as the Zigbee adapter announces one nobody has named. */
const climate = (externalId: string, extra: Partial<AdapterDeviceDescriptor> = {}): AdapterDeviceDescriptor => ({
  adapter: 'zigbee',
  externalId,
  vendor: 'Tuya',
  model: 'TS0201',
  suggestedName: `Smart temperature and humidity sensor ${externalId.slice(-4).toUpperCase()}`,
  suggestedNameIsModel: true,
  nameHint: 'Smart temperature and humidity sensor',
  endpoints: [
    { endpointId: 1, deviceKind: 'sensor', capabilities: ['temperature', 'humidity', 'battery'], primary: 'temperature' },
  ],
  ...extra,
});

describe.skipIf(!handle)('naming devices in the registry', () => {
  const db = handle?.db!;
  let events: HubEventBus;
  let registry: DeviceRegistry;
  let adapter: FakeAdapter;

  const boot = async (): Promise<void> => {
    events = new HubEventBus();
    adapter = new FakeAdapter();
    registry = new DeviceRegistry(db, events, new ActivityService(db, events), log);
    registry.registerAdapter(adapter);
    await registry.start();
  };
  const named = (externalId: string) => registry.listDevices().find((device) => device.externalId === externalId)!;

  beforeEach(async () => {
    await resetDb(db);
    await boot();
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('gives a new device a short name for what it is, and keeps its model as it was', async () => {
    adapter.bus!.deviceUpserted(climate('0xaaaafea7'));
    await registry.flush();
    const device = named('0xaaaafea7');
    expect(device.name).toBe('Climate sensor');
    expect(device.nameSource).toBe('hub');
    expect(device).toMatchObject({ vendor: 'Tuya', model: 'TS0201' });
    // Nothing is offered over a name that is already short and the hub's own.
    expect(deviceWire(device, false, { suggestNames: (entry) => registry.nameSuggestions(entry) })).toMatchObject({
      name: 'Climate sensor',
      nameSource: 'hub',
      vendor: 'Tuya',
      model: 'TS0201',
    });
    expect(registry.nameSuggestions(device)).toEqual([]);
  });

  it('numbers the second, even when two arrive in the same instant', async () => {
    // Two devices have two write queues: both names are worked out before
    // either row exists.
    adapter.bus!.deviceUpserted(climate('0xaaaa0001'));
    adapter.bus!.deviceUpserted(climate('0xaaaa0002'));
    await registry.flush();
    expect(registry.listDevices().map((device) => device.name).sort()).toEqual([
      'Climate sensor',
      'Climate sensor 2',
    ]);
  });

  it('takes the name recognition returned with the mapping, when it is one', async () => {
    adapter.bus!.deviceUpserted(climate('0xaaaa0001', { plainName: 'Thermometer' }));
    adapter.bus!.deviceUpserted(climate('0xaaaa0002', { plainName: 'Tuya TS0201 temperature and humidity sensor' }));
    await registry.flush();
    expect(named('0xaaaa0001')).toMatchObject({ name: 'Thermometer', nameSource: 'recognition' });
    // A product sheet is not a name: the hub's own is used instead.
    expect(named('0xaaaa0002')).toMatchObject({ name: 'Climate sensor', nameSource: 'hub' });
  });

  it('keeps a name somebody chose in the protocol’s own tool', async () => {
    adapter.bus!.deviceUpserted({ ...climate('0xaaaa0001'), suggestedName: 'Nursery', suggestedNameIsModel: false });
    await registry.flush();
    expect(named('0xaaaa0001')).toMatchObject({ name: 'Nursery', nameSource: 'upstream' });
  });

  it('never replaces a name a person gave — not on re-announcement, not by recognition', async () => {
    adapter.bus!.deviceUpserted(climate('0xaaaa0001'));
    await registry.flush();
    const id = named('0xaaaa0001').id;
    await registry.updateDevice(id, { name: 'Baby’s room' });
    expect(registry.getDevice(id)).toMatchObject({ name: 'Baby’s room', nameSource: 'person' });

    adapter.bus!.deviceUpserted(climate('0xaaaa0001', { plainName: 'Thermometer' }));
    await registry.flush();
    expect(registry.getDevice(id)).toMatchObject({ name: 'Baby’s room', nameSource: 'person' });

    // And it is still theirs after a restart.
    await boot();
    adapter.bus!.deviceUpserted(climate('0xaaaa0001', { plainName: 'Thermometer' }));
    await registry.flush();
    expect(registry.getDevice(id)).toMatchObject({ name: 'Baby’s room', nameSource: 'person' });
    expect(registry.nameSuggestions(registry.getDevice(id)!)).toEqual([]);
  });

  it('improves its own word once when recognition names the model later, and not again', async () => {
    adapter.bus!.deviceUpserted(climate('0xaaaa0001'));
    await registry.flush();
    const id = named('0xaaaa0001').id;

    adapter.bus!.deviceUpserted(climate('0xaaaa0001', { plainName: 'Thermometer' }));
    await registry.flush();
    expect(registry.getDevice(id)).toMatchObject({ name: 'Thermometer', nameSource: 'recognition' });

    // Worked out again, with a different answer: the name stays where it is.
    adapter.bus!.deviceUpserted(climate('0xaaaa0001', { plainName: 'Weather station' }));
    await registry.flush();
    expect(registry.getDevice(id)).toMatchObject({ name: 'Thermometer', nameSource: 'recognition' });
    const [row] = await db.select().from(devices).where(eq(devices.id, id));
    expect(row).toMatchObject({ name: 'Thermometer', nameSource: 'recognition' });
  });

  describe('a device adopted before the hub kept track', () => {
    /** A row as an older build wrote it: the model's name, and no source. */
    const legacy = async (externalId: string, name: string): Promise<string> => {
      const [row] = await db
        .insert(devices)
        .values({ adapter: 'zigbee', externalId, vendor: 'Tuya', model: 'TS0201', name })
        .returning();
      return row!.id;
    };

    it('is not renamed, and is offered short names instead — with its room once it has one', async () => {
      const id = await legacy('0xaaaafea7', 'Smart temperature and humidity sensor FEA7');
      const [room] = await db.insert(rooms).values({ name: 'Bedroom' }).returning();
      await boot();
      adapter.bus!.deviceUpserted(climate('0xaaaafea7', { plainName: 'Thermometer' }));
      await registry.flush();

      const device = registry.getDevice(id)!;
      expect(device.name).toBe('Smart temperature and humidity sensor FEA7');
      expect(device.nameSource).toBe('model');
      expect(registry.nameSuggestions(device)).toEqual(['Thermometer', 'Climate sensor']);

      await registry.updateDevice(id, { roomId: room!.id });
      const wire = deviceWire(registry.getDevice(id)!, false, {
        suggestNames: (entry) => registry.nameSuggestions(entry),
      });
      expect(wire).toMatchObject({
        name: 'Smart temperature and humidity sensor FEA7',
        nameSource: 'model',
        nameSuggestions: ['Bedroom thermometer', 'Thermometer', 'Climate sensor'],
      });
    });

    it('stops being offered names the moment a person names it', async () => {
      const id = await legacy('0xaaaafea7', 'Smart temperature and humidity sensor FEA7');
      await boot();
      adapter.bus!.deviceUpserted(climate('0xaaaafea7'));
      await registry.flush();
      expect(registry.nameSuggestions(registry.getDevice(id)!)).toEqual(['Climate sensor']);

      await registry.updateDevice(id, { name: 'Climate sensor' });
      const wire = deviceWire(registry.getDevice(id)!, false, {
        suggestNames: (entry) => registry.nameSuggestions(entry),
      });
      expect(wire).toMatchObject({ name: 'Climate sensor', nameSource: 'person' });
      expect(wire).not.toHaveProperty('nameSuggestions');
    });

    it('is left entirely alone when its name is not the model’s — it may be somebody’s', async () => {
      const id = await legacy('0xaaaafea7', 'Nursery');
      await boot();
      adapter.bus!.deviceUpserted(climate('0xaaaafea7', { plainName: 'Thermometer' }));
      await registry.flush();
      const device = registry.getDevice(id)!;
      expect(device).toMatchObject({ name: 'Nursery', nameSource: null });
      expect(registry.nameSuggestions(device)).toEqual([]);
      // Unknown is said by absence, never by a guess.
      expect(deviceWire(device, false)).not.toHaveProperty('nameSource');
    });
  });
});
