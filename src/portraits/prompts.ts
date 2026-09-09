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

/**
 * The finish, and it is written for a model that does what it is told.
 *
 * This used to read `matte soft-touch … with one calm cobalt-blue accent light`, which
 * `gpt-image-2` interpreted loosely and gave a sheen to anyway. 2.5 adheres far more
 * closely, so it rendered the sentence exactly: a dry, chalky, desaturated surface with
 * no highlight anywhere and the accent reduced to a few stray pixels. The render was not
 * worse — it was *more faithful to a prompt that asked for the wrong thing*.
 *
 * So the finish now says what a premium matte object actually does with light: matte is
 * about the **roll-off**, not the absence of a highlight, and a body with no tonal range
 * across it reads as unfinished plastic however dark it is. And the cobalt is named as
 * the device's **own indicator** rather than as a coloured light in the scene, because
 * that is what it is — a lamp with a blue studio light on it is a photograph of a
 * different object.
 */
const PALETTE =
  'a soft-touch dark graphite body (#141414) that is matte but not flat — an even, fine ' +
  'micro-texture with a gentle sheen along its curves and smooth highlight roll-off, never ' +
  'dry or chalky — and one calm cobalt-blue indicator light (#3A65C2) on the device itself, ' +
  'glowing softly and throwing a faint cool bloom onto the graphite around it';

/**
 * Where the light comes from, which the old prompt never said.
 *
 * "Soft top light and gentle rim light" names two lights and not one direction, and a
 * model with nothing else to go on lights the object evenly from the front — which is
 * exactly the flat, shadowless look that made the graphite read as grey card. Naming the
 * key, the fill and the rim, and where each is, is the difference between a lit object
 * and a filled-in silhouette.
 */
const LIGHTING =
  'Light it the way a product is lit: a large softbox high and to the front-left as the key, ' +
  'laying one broad soft highlight down the top of the form; a weaker fill from the right so ' +
  'the shadow side still reads as shape rather than going black; and a narrow rim tracing the ' +
  'far edge. Deep blacks with real tonal range across the body, not one flat grey.';

/**
 * The angle, and it is deliberately only on the *generate* path.
 *
 * With no photo the model invents the whole object anyway, so asking for the three-quarter
 * view every product page uses costs nothing and is the single cheapest improvement here —
 * a device shot head-on reads as a flat cut-out whatever its finish. The edit path is told
 * the opposite, to keep the photo's own viewpoint: turning an object there means inventing
 * the sides the camera never saw, which is precisely where an unusual device stops being
 * itself.
 */
const VIEWPOINT =
  'Show it from a three-quarter view, turned a little off head-on and seen from slightly ' +
  'above, so the front and one side both read and it has depth.';

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
 *
 * **What it no longer does is name a scene, and that is OpenAI's own rule for
 * transparent assets rather than a preference of ours.** A prompt's instructions
 * take priority over `background: transparent`, so a backdrop mentioned
 * *anywhere* — including inside a ban on it — is a backdrop the model may decide
 * to draw instead of leaving the frame empty. "Empty space", "no ground plane",
 * "no surface beneath it" and "no scenery" were four of them standing directly
 * in front of the one capability this whole path exists for. The **shadow** ban
 * stays exactly as it was: a shadow is something the object casts rather than a
 * place it is standing in, and that variant list is what stopped the soft ground
 * shadow in the first place. What changed is that the rule is now put entirely
 * as a fact about the object — it rests on nothing and casts nothing — with the
 * transparency stated positively and first.
 */
const FLOATING_ALONE =
  'The object is isolated: every pixel that is not the object itself is fully ' +
  'transparent. It rests on nothing and casts nothing — no cast shadow, no drop ' +
  'shadow, no contact shadow, no reflection, and no light pooling beneath it. ' +
  'No text and no logos. ' +
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
    `Studio product render of a ${NOUNS[kind]}, a single object. The device has ${PALETTE}. ` +
    `Premium, minimal, Dieter-Rams-like industrial design, smooth rounded forms. ${VIEWPOINT} ` +
    `${LIGHTING} On a fully transparent background. ${FLOATING_ALONE}`
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
  'do not change what the object is or turn it into a different product, and keep the ' +
  `viewpoint the photo was taken from. Only restyle its surface finish: give it ${PALETTE}. ` +
  `${LIGHTING} On a fully transparent background. Keep only the object itself from the photo: ` +
  `nothing that surrounds it there carries over. ${FLOATING_ALONE}`;
