/**
 * The words a room picture is drawn, lit and read from.
 *
 * **Photos in, a modelled room out.** The day picture is drawn from photos of
 * the room alone — no plan, no scan: an image model given a few corners of a
 * room reproduces its shape, its furniture and its materials far better than
 * it follows a measured skeleton, which is what the first version sent it.
 * Each image's role is named, because a model given a pile of pictures blends
 * them.
 *
 * **Nothing is asked for that the photos don't show.** The prompt names no
 * device and carries no portrait. It did both once, so that every device would
 * be drawn for its marker to stand on — and a sensor too small to see in any
 * photo was then invented, drawn somewhere it is not, in a picture of a room
 * the person who lives there is meant to recognise. The devices are found on
 * the finished picture instead (`locatePrompt`): on the thing itself where it
 * was drawn because the photos showed it, and where it most plausibly is where
 * it wasn't — a marker, which a person can move, rather than an object painted
 * into their room.
 *
 * **This room at its best, drawn as one box.** The room is a 3D render of
 * itself in its own colours, materials and patterns, tidied and polished — what
 * the first drawings asked for, on 2026-10-23, and still the best of them on
 * the owner's own flat. Later the same day it became a designed illustration
 * instead: a curated palette with patterns calmed to solid tones, the room seen
 * close and filling the picture edge to edge. On 2.6 Sunburst that came apart on
 * a long room with a kitchen niche at one end — drawn under a many-sided
 * outline, the kitchen a second box in front of the first (2026-11-10). So the
 * geometry is written as a specification rather than left to the model's
 * planning: one room on one level floor, one solid box, two walls standing and
 * two cut low, the whole room in the frame with space around it. That is
 * OpenAI's own advice for 2.6 — a fully specified design leaves a model
 * planning at `high` complexity little to reinterpret. **The arrangement is
 * kept**: what stands against which wall, and in what order. Distances may be
 * evened out and an alcove folded into the box, since a room recognised at a
 * glance is the point, and the devices' markers are read off the finished
 * picture either way.
 *
 * **Day, then night as an edit of the day** — the same picture with the light
 * changed, so the apps cross from one to the other with nothing moving.
 */

export interface PictureDevice {
  id: string;
  name: string;
  /** The device's kind, in words (`light`, `outlet`, `sensor`…). */
  kind: string;
}

/** How the room looks — its own colours, materials and patterns, at their best. */
const LOOK =
  'The look: the room’s own colours, materials and patterns — the wall paint, the floor, the woods, the fabrics, ' +
  'the prints on the curtains and cushions — so that it is unmistakably this room, at its best: clean, fresh and ' +
  'cared for, as if newly finished and styled for a photograph. Crisp, clean geometry with gently softened edges, ' +
  'matte materials with a subtle sheen, rich fine detail. Soft, diffuse daylight from the windows, gentle global ' +
  'illumination, soft ambient occlusion and soft contact shadows — no harsh light, no glare, no colour casts. The ' +
  'walls are thick, clean slabs, their cut tops a slightly darker tone; a thin floor slab under the room. Calm, ' +
  'tidy and quietly luxurious, highly detailed';

/** What a kind of device is, in the words a picture is read with. */
export function describeKind(kind: string): string {
  switch (kind) {
    case 'light':
      return 'a light';
    case 'outlet':
      return 'a smart plug — look for what it powers';
    case 'wallSwitch':
      return 'a light switch on a wall';
    case 'sensor':
      return 'a small sensor';
    case 'climate':
      return 'a thermostat or climate unit';
    case 'airPurifier':
      return 'an air purifier';
    case 'fan':
      return 'a fan';
    case 'lock':
      return 'a smart lock on a door';
    case 'shade':
      return 'blinds or curtains on a motor';
    case 'speaker':
      return 'a speaker';
    case 'tv':
      return 'a TV';
    case 'camera':
      return 'a small camera';
    case 'vacuum':
      return 'a robot vacuum';
    case 'appliance':
      return 'a home appliance';
    case 'energy':
      return 'an energy meter';
    case 'remote':
      return 'a small remote or button';
    default:
      return 'a smart device';
  }
}

/**
 * The day picture, from `photoCount` photos of the room and nothing else — in
 * labelled sections, the shape OpenAI's prompting guide gives a complex
 * request: what the photos are, what to draw, then the view, the shape, what is
 * in it, the look and the frame, each a constraint the model is held to.
 */
export function dayPrompt(roomName: string, photoCount: number, orientation: 'portrait' | 'landscape'): string {
  const name = roomName.trim().length > 0 ? `“${roomName.trim()}”` : 'one room';
  const frame = orientation === 'portrait' ? 'tall' : 'wide';
  return [
    photoCount === 1
      ? `The first image is a phone photo of ${name}, a room of a real home.`
      : `The first ${photoCount} images are phone photos of ${name}, a room of a real home, taken from different ` +
        'corners. Together they show one room: work out its shape and where everything in it stands from all of ' +
        'them, and draw that one room.',
    'Ignore any white guide lines, buttons and other on-screen overlays in the photos.',
    '',
    'Draw this room as the room picture of a premium smart-home app: a beautiful, highly detailed 3D render of ' +
      'this very room as an isometric dollhouse cutaway, modelled the way a top 3D artist would for a showcase.',
    '',
    'The view: true isometric — parallel lines stay parallel — from high above at about 35 degrees, looking into ' +
      'one corner of the room, which stands near the top centre of the image. The two walls that meet in that ' +
      'corner stand full height, receding to the left and the right; the two walls nearest the viewer are cut ' +
      'down to a low ledge along the floor, so the whole room can be seen into. Choose the corner that puts the ' +
      'windows and the main pieces on the two standing walls where it can.',
    '',
    'The shape: one room on one level floor, built as one solid box. The floor is a single rectangle, and the ' +
      'four walls stand on its edges as straight, unbroken slabs meeting at right angles, the two low ones cut ' +
      'level along their whole length. An alcove or niche — a kitchen recess, a bay — is part of that box, against ' +
      'one of its walls. Never split the room into separate blocks, boxes or levels, and never give it corners or ' +
      'angles it does not have.',
    '',
    'What is in it: every piece of furniture, every appliance, every door, window and fixture the photos show, at ' +
      'its real size, facing the way it faces, against the wall the photos show it against and in the same order ' +
      'along it — the person who lives here must recognise their own room at a glance. Nothing is swapped, added ' +
      'or left out; what stands along the two low walls stays, cut down with them where it would hide the room. ' +
      'The room may be drawn a little more regular than it is — distances evened out, its outline a clean box — ' +
      'but its arrangement is kept. Tidy away clutter, laundry, drying racks, bags, cables and mess, and ignore ' +
      'the photos’ dim lighting and colour casts.',
    '',
    'Draw only what the photos show. Add nothing that is not in them — no devices, sensors, gadgets, lamps or ' +
      'other objects the room does not have.',
    '',
    `${LOOK}.`,
    '',
    `The frame: the whole room is in the ${frame} image, centred, filling most of it with a little clear space on ` +
      'every side — nothing cut off at the edges — standing on its own on a transparent background, with no ' +
      'floor, backdrop or shadow beyond the room itself.',
    '',
    'No text, no labels, no people, no watermark.',
  ].join('\n');
}

/** The night picture, as an edit of the finished day picture. */
export const NIGHT_PROMPT = [
  'The image is a 3D render of one room of a home, by day. Redraw the very same render at night.',
  '',
  'Change only the light. Keep everything else exactly as it is: the camera and the framing, the room’s outline ' +
    'against the background, every wall, every piece of furniture and every object, each with its shape, ' +
    'material and colour, the composition — this picture is laid exactly over the day one.',
  '',
  'Night, as a premium smart-home app’s night mode: the room is dark and calm, its surfaces in deep, rich ' +
    'charcoal and warm shadow; the daylight is gone and the windows show deep blue night. The room’s own lights ' +
    'are on — the ceiling lights, any lamp, any light under cabinets or shelves — each giving a warm amber glow ' +
    'and soft pools of light on the floor, the furniture and the walls near it, falling off softly into ' +
    'darkness. The cut tops of the walls are dark grey. Screens are off. The background around the room is ' +
    'plain, flat and near-black, with nothing on it. Moody, warm, high in contrast, quietly luxurious.',
  '',
  'No text, no labels, no people, no watermark.',
].join('\n');

/** Where each device stands in the finished day picture. */
export function locatePrompt(devices: PictureDevice[]): string {
  return [
    'The image is a picture of one room of a home: an isometric cutaway. These smart devices are in the room:',
    ...devices.map((device) => `- ${device.id}: “${device.name}” (${describeKind(device.kind)})`),
    '',
    'For each device, give the point in the image where its marker should stand: on the device itself where it ' +
      'is drawn; otherwise on the thing it powers or works (a plug’s lamp or TV, a lock’s door); otherwise where ' +
      'such a device would most plausibly be in this room — a ceiling light over the middle of the main space, a ' +
      'sensor on a wall. x and y are fractions of the image’s width and height, from its top-left corner, and the ' +
      'point must be on the room, never on the empty background. `seen` says whether the device itself is drawn. ' +
      'Keep two devices of the same kind apart, and answer for every device listed, by its id.',
  ].join('\n');
}
