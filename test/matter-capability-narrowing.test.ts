import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_CLUSTERS,
  DEVICE_TYPE_CATALOG,
  descriptorFor,
  restrictToClusters,
  type CapabilityKind,
} from '../src/schema/index.js';

/**
 * A device type says what an endpoint **may** implement; the clusters on the
 * endpoint say what it **does**.
 *
 * Matter is strict and machine-readable about exactly this difference — the
 * Descriptor cluster's `ServerList` is the accessory's own statement — and the
 * catalog is the looser of the two: a Smart Plug's Electrical Power
 * Measurement is optional, a contact sensor may be mains-powered and carry no
 * Power Source. Announcing the type's list wholesale meant claiming
 * capabilities the accessory had already said it hasn't got, and the apps drew
 * a reading slot that could never fill.
 *
 * Found on a Yandex YNDX-00540 plug, which reports `electricalPower` from its
 * type and implements neither 0x0090 nor 0x0091. What it carries instead is
 * Zigbee's own 0x0B04 — **not a Matter cluster at all**: matter.js's
 * spec-generated model has no entry for it, which is why its attributes came
 * through as `attr$505` rather than by name. Special-casing one vendor's
 * non-standard choice inside a universal adapter is the wrong direction; the
 * right one is to believe what the protocol already told us.
 */
describe('narrowing a device type to what an endpoint really implements', () => {
  const smartPlug = descriptorFor([0x010a]);

  it('starts from a catalog that lists what the type allows', () => {
    expect(smartPlug.kind).toBe('outlet');
    expect(smartPlug.capabilities).toEqual(['onOff', 'electricalPower']);
  });

  it('drops a reading the accessory cannot report', () => {
    // OnOff (6), Identify (3), Groups (4), Descriptor (29), and Zigbee's 0x0B04
    // — which is what the plug in question actually has.
    const narrowed = restrictToClusters(smartPlug, [0x0003, 0x0004, 0x0006, 0x001d, 0x0b04]);
    expect(narrowed.capabilities).toEqual(['onOff']);
    expect(narrowed.kind).toBe('outlet');
  });

  it('keeps it when the accessory really does implement it', () => {
    expect(restrictToClusters(smartPlug, [0x0006, 0x0090]).capabilities).toEqual([
      'onOff',
      'electricalPower',
    ]);
    // Energy-only counts too — a plug that meters cumulative use and not
    // instantaneous draw still has something to say.
    expect(restrictToClusters(smartPlug, [0x0006, 0x0091]).capabilities).toEqual([
      'onOff',
      'electricalPower',
    ]);
  });

  it('returns the very same descriptor when nothing is dropped', () => {
    // Identity, not a copy: this runs per endpoint on every announce, and an
    // allocation per device per report is the kind of cost that is invisible
    // on a laptop and measurable on a Zero 2 W.
    const clusters = [0x0006, 0x0090];
    expect(restrictToClusters(smartPlug, clusters)).toBe(smartPlug);
  });

  it('never drops the primary, however broken the endpoint is', () => {
    // The capability the apps lead with; a device card has to have one. An
    // endpoint missing its primary cluster is malformed, and quietly choosing
    // a different primary would hide that behind a card that looks fine and
    // does nothing.
    const narrowed = restrictToClusters(smartPlug, [0x001d]);
    expect(narrowed.capabilities).toEqual(['onOff']);
    expect(narrowed.primary).toBe('onOff');
  });

  it('drops an optional battery from a mains-powered sensor', () => {
    // The same rule, nothing to do with plugs: `battery` is on nearly every
    // sensor in the catalog and is optional on all of them.
    const contact = descriptorFor([0x0015]);
    expect(contact.capabilities).toContain('battery');
    expect(restrictToClusters(contact, [0x0045]).capabilities).toEqual(['contact']);
    expect(restrictToClusters(contact, [0x0045, 0x002f]).capabilities).toEqual([
      'contact',
      'battery',
    ]);
  });

  it('keeps a capability nobody has mapped to a cluster', () => {
    // The safe direction. A capability added to the catalog and forgotten in
    // the cluster table would otherwise vanish from every device that has it —
    // a far worse failure than an over-claim, and a silent one.
    const withUnmapped = { ...smartPlug, capabilities: ['onOff', 'custom'] as CapabilityKind[] };
    expect(restrictToClusters(withUnmapped, [0x0006]).capabilities).toEqual(['onOff', 'custom']);
  });
});

/**
 * The two invariants that keep the narrowing from quietly costing somebody a
 * feature.
 *
 * Dropping is the destructive direction, and it is silent: a wrong cluster id
 * here does not fail, it just means a washing machine arrives without its
 * programme. Eyeballing the table caught the plug and missed the vacuum —
 * `mode` was listed as ModeSelect alone, while every appliance in the catalog
 * carries its *own* Mode Base cluster instead. These are what caught that.
 */
describe('the capability → cluster table', () => {
  it('names clusters that exist, checked against the spec itself', async () => {
    // matter.js's model is generated from the Matter specification, so this is
    // the real thing rather than a second copy of my reading of it. It lives
    // in the adapter's dependency rather than in `src/schema/` — which is
    // dependency-free by design — so the check belongs here, in a test.
    const { MatterModel } = await import('@matter/main/model');
    const known = new Set(
      MatterModel.standard.clusters
        .map((cluster) => cluster.id)
        .filter((id): id is number => id !== undefined),
    );
    // The Switch cluster is read by the adapter rather than the reducer, so it
    // is in the table and not in `Cluster` below; it still has to be real.
    for (const [capability, clusters] of Object.entries(CAPABILITY_CLUSTERS)) {
      for (const cluster of clusters ?? []) {
        expect.soft(known.has(cluster), `${capability} → 0x${cluster.toString(16)}`).toBe(true);
      }
    }
  });

  it('claims every cluster the reducer can actually read', async () => {
    // **The invariant that matters.** If the reducer populates state from a
    // cluster and no capability lists it, then an endpoint carrying only that
    // cluster loses the capability — silently, at announce time, on hardware
    // nobody here owns. This is what would have caught `mode`: the reducer has
    // read `RvcRunMode` since long before this table existed, and the table
    // listed only `ModeSelect`.
    const { Cluster } = await import('../src/adapters/matter/reducer.js');
    const claimed = new Set(Object.values(CAPABILITY_CLUSTERS).flatMap((ids) => [...(ids ?? [])]));
    for (const [name, id] of Object.entries(Cluster)) {
      // Descriptor is plumbing — it is how endpoints are found, and it fills
      // no capability of its own.
      if (name === 'descriptor') continue;
      expect.soft(claimed.has(id), `reducer reads ${name} (0x${id.toString(16)}) for nothing`).toBe(true);
    }
  });

  it('gives every appliance in the catalog a mode it can really report', () => {
    // The catalog hands `mode` to nine device types. Each implements its own
    // Mode Base cluster and nothing else, so before this table learned them
    // all, every one of them would have lost it.
    const modes: Array<[number, number]> = [
      [0x0074, 0x0054], // Robotic Vacuum Cleaner → RvcRunMode
      [0x0073, 0x0051], // Laundry Washer         → LaundryWasherMode
      [0x0075, 0x0059], // Dishwasher             → DishwasherMode
      [0x007b, 0x0049], // Oven                   → OvenMode
      [0x0070, 0x0052], // Refrigerator           → RefrigeratorAndTemperatureControlledCabinetMode
      [0x0079, 0x005e], // Microwave Oven         → MicrowaveOvenMode
      [0x050c, 0x009d], // EVSE                   → EnergyEvseMode
      [0x050f, 0x009e], // Water Heater           → WaterHeaterMode
    ];
    for (const [deviceTypeId, clusterId] of modes) {
      const descriptor = descriptorFor([deviceTypeId]);
      expect(descriptor.capabilities).toContain('mode');
      const narrowed = restrictToClusters(descriptor, [clusterId, 0x0006, 0x0402]);
      expect.soft(narrowed.capabilities, `device type 0x${deviceTypeId.toString(16)}`).toContain('mode');
    }
  });
});

describe('every device type in the catalog', () => {
  it('keeps all of its capabilities when the accessory implements them', () => {
    // The universal check, and the one that covers the device types nobody
    // here owns. For each entry: build the endpoint its own type describes —
    // every cluster the table maps its capabilities to — and assert nothing is
    // dropped. A wrong id anywhere in the table fails here for that device
    // type by name, rather than on somebody's oven a year from now.
    for (const entry of DEVICE_TYPE_CATALOG) {
      const clusters = entry.capabilities.flatMap((capability) => [
        ...(CAPABILITY_CLUSTERS[capability] ?? []),
      ]);
      const narrowed = restrictToClusters(entry, clusters);
      expect
        .soft(narrowed.capabilities, `${entry.name} (0x${entry.id.toString(16)})`)
        .toEqual(entry.capabilities);
    }
  });

  it('has a primary that is one of its own capabilities', () => {
    // Not about narrowing, but it is what makes the "primary always survives"
    // rule safe: a primary outside the list would be kept as a capability the
    // device never had.
    for (const entry of DEVICE_TYPE_CATALOG) {
      expect.soft(entry.capabilities, entry.name).toContain(entry.primary);
    }
  });
});
