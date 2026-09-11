import { describe, expect, it } from 'vitest';
import { descriptorFor, restrictToClusters, type CapabilityKind } from '../src/schema/index.js';

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
