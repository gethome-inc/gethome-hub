/**
 * What the hub asks for when it draws a device.
 *
 * These are the GetHome app's own prompts, moved here rather than sent up with
 * each request. Two reasons. A portrait is the *house's* — everybody in the
 * home sees the same picture — so the picture cannot depend on which app asked
 * for it or which version of that app is installed. And the hub already knows
 * the device's canonical `kind`, so a caller has nothing to add: it says
 * "draw this device", optionally with a photo, and that is the whole request.
 *
 * The palette is the app's, and that is deliberate: a portrait is drawn to sit
 * on a GetHome device page, in GetHome's cobalt, the way `rooms.icon` holds a
 * token only the apps know how to draw.
 */

import type { DeviceKind } from '../schema/index.js';

const PALETTE =
  'matte soft-touch dark graphite body (#141414) with one calm cobalt-blue accent light (#3A65C2) glowing softly';

/**
 * Both prompt paths end with this: the render must be the object and *nothing
 * else*, dead-centred. A single "no cast shadow" proved too easy for the model
 * to ignore — it loves sneaking a soft ground shadow under the object — so the
 * ban names every variant and states the rule positively. Shadows and glows are
 * the app's job (each surface draws its own when it wants one), never baked into
 * the render. Centring *and scale* are spelled out so the object lands in the
 * middle at a consistent ~80% of the frame, independent of how a reference photo
 * was framed. The apps normalise what comes back as well, because the model
 * still drifts; the prompt only gets the raw render close.
 */
const FLOATING_ALONE =
  'The object floats alone in empty space: no ground plane, no surface beneath it, ' +
  'no cast shadow, no drop shadow, no contact shadow, no reflection, and no light ' +
  'pooling under the object. Every pixel outside the object itself is fully ' +
  'transparent. No text, no logos, no scenery. ' +
  'Center the object precisely in the square frame — its visual middle at the exact ' +
  "center of the image, both horizontally and vertically — sized so the object's longest " +
  'side spans about 80% of the frame, leaving a small, roughly equal margin of transparent ' +
  'space on all four sides. Use this same framing every time, regardless of how large, ' +
  'small, near, far, cropped, or zoomed the object appears in any reference photo: the ' +
  "reference defines only the object's shape, never its size in the output. Do not crop " +
  'it, cut it off, or push it toward any edge or corner.';

/**
 * A noun per device kind, because "draw a `wallSwitch`" is not English and the
 * model draws the category it recognises rather than the token we happen to use.
 */
const NOUNS: Record<DeviceKind, string> = {
  light: 'modern smart table lamp',
  camera: 'compact home security camera',
  sensor: 'small round smart environment sensor',
  climate: 'round smart thermostat dial',
  lock: 'smart door lock',
  outlet: 'smart wall plug',
  airPurifier: 'cylindrical smart air purifier',
  shade: 'motorized window shade roller',
  speaker: 'compact smart speaker',
  wallSwitch: 'smart light wall switch',
  fan: 'smart pedestal fan',
  vacuum: 'round robot vacuum',
  appliance: 'smart home appliance',
  energy: 'smart energy monitor',
  tv: 'slim smart television',
  remote: 'small smart wireless button remote',
};

/** No photo: the device kind is all the model has to go on. */
export function generatePrompt(kind: DeviceKind): string {
  return (
    `Ultra-clean studio product render of a ${NOUNS[kind]}, a single object, centered and ` +
    `floating. ${PALETTE}. Premium, minimal, Dieter-Rams-like, smooth rounded forms, soft ` +
    `top light and gentle rim light, on a fully transparent background. ${FLOATING_ALONE}`
  );
}

/**
 * With a photo: take the *shape* from the photo and change only the finish.
 *
 * It deliberately never names the device kind. The thing somebody points a
 * camera at may be anything — the lamp an outlet feeds, an unusual fixture —
 * and the render has to be *that* object rather than its category's stock shape.
 */
export const EDIT_PROMPT =
  'Recreate the exact object shown in this photo as a premium studio product render. ' +
  'Preserve its true shape, proportions, silhouette, parts, and every recognizable detail — ' +
  'do not change what the object is or turn it into a different product. Only restyle its ' +
  `surface finish: give it a ${PALETTE}. Center it and float it on a fully transparent ` +
  'background, with soft top light and a gentle rim light. Leave the photo’s background, ' +
  `floor, and shadows behind — they are not part of the object. ${FLOATING_ALONE}`;
