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
 * **Beautiful before realistic, but never rearranged.** The room is drawn as
 * a designed 3D illustration of itself — a calm, curated palette taken from its
 * own colours, clean softly modelled shapes, soft studio light, seen close from
 * high above its far corner — rather than as a photograph of it, because that
 * is what makes it a pleasure to look at every day. What it may not do is move
 * anything: every piece of furniture, door and window stays where the photos
 * show it, at its size and against its wall, since that is what makes it this
 * room, and what the devices' markers are placed by.
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

const STYLE =
  'The look: a calm, harmonious, curated palette taken from the room’s own colours but softened and unified — ' +
  'warm off-whites, soft greys, gentle taupes and woods, with the room’s main colour kept as one muted accent; ' +
  'busy patterns on fabrics and floors become calm, solid tones. Clean, softly modelled shapes with gentle rounded ' +
  'edges, matte and satin materials. Soft, even studio light with gentle global illumination, soft ambient ' +
  'occlusion and soft contact shadows — no harsh light, no glare, no colour casts. The walls are thick, clean ' +
  'slabs, cut flat along the top in a light tone; a thin floor slab under the room. Minimal, airy and quietly ' +
  'luxurious, like a premium 3D render for a smart-home app';

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

/** The day picture, from `photoCount` photos of the room and nothing else. */
export function dayPrompt(roomName: string, photoCount: number, orientation: 'portrait' | 'landscape'): string {
  const name = roomName.trim().length > 0 ? `“${roomName.trim()}”` : 'one room';
  const lines: string[] = [];
  lines.push(
    photoCount === 1
      ? `The first image is a phone photo of ${name}, a room of a real home.`
      : `The first ${photoCount} images are phone photos of ${name}, a room of a real home, taken from different corners.`,
  );
  lines.push(
    'Ignore any white guide lines, buttons and other on-screen overlays in the photos.',
    '',
    'Draw this room as a beautiful 3D illustration for a premium smart-home app: an isometric diorama of the ' +
      'room, modelled and rendered the way a top 3D designer would for a showcase — designed, not photographed.',
    '',
    'The view: isometric, from high above at about 35 degrees, looking into the room’s far corner, which stands ' +
      'near the top centre of the image; the two far walls rise full height from it, receding to the left and ' +
      'the right, and the two near walls are removed so the whole room can be seen into. Choose the corner that ' +
      'shows the most of the room — the windows and the main furniture against the two far walls. The room is ' +
      'seen close.',
    '',
    'The layout is exact: every piece of furniture, every appliance, every door, window and fixture stands where ' +
      'the photos show it, at its real size, facing the way it faces, against the same wall — the person who lives ' +
      'here must recognise their own room at a glance. Each thing becomes a clean, softly modelled version of ' +
      'itself; nothing is moved, swapped, added or left out — whatever stands against the two removed walls stays, ' +
      'cut away low at the front like the walls themselves. Tidy away clutter, laundry, bags, cables and mess, and ' +
      'ignore the photos’ dim lighting and colour casts.',
    '',
    'Draw only what the photos show. Add nothing that is not in them — no devices, sensors, gadgets, lamps or ' +
      'other objects the room does not have.',
  );
  lines.push(
    '',
    `${STYLE}.`,
    '',
    `The room fills the ${orientation === 'portrait' ? 'tall' : 'wide'} image almost edge to edge, standing on its ` +
      'own on a transparent background — no floor, backdrop or shadow beyond the room itself.',
    '',
    'No text, no labels, no people, no watermark.',
  );
  return lines.join('\n');
}

/** The night picture, as an edit of the finished day picture. */
export const NIGHT_PROMPT = [
  'The image is a 3D illustration of one room of a home, by day. Redraw the very same illustration at night.',
  '',
  'Keep everything exactly as it is: the camera angle and framing, the room, every wall, every piece of ' +
    'furniture, every material and colour, the composition. Only the light changes.',
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
