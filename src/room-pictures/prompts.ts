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
  'Soft, diffuse daylight from the windows, gentle ambient occlusion, soft contact shadows, matte materials with a ' +
  'subtle sheen, crisp clean geometry, walls cut as thick clean sections with a slightly darker top edge, a thin ' +
  'floor slab under the room. Calm, tidy and quietly luxurious, highly detailed';

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
    'Draw this room as the room render of a premium smart-home app: an isometric cutaway of the whole room, seen ' +
      'from above at about 35 degrees from one corner, the two walls nearest the viewer removed so the room can be ' +
      'seen into like a dollhouse, the two far walls standing full height. A 3D artist’s model of this very room: ' +
      'its real shape and proportions, every piece of furniture where the photos show it, in the room’s real ' +
      'colours, materials and textures — the floor, the wall paint, the furniture, the fabrics, the appliances, ' +
      'the curtains — so the person who lives here recognises their own room at a glance. Tidy away clutter, bags ' +
      'and mess, and ignore the photos’ dim lighting and colour casts.',
    '',
    'Draw only what the photos show. Add nothing that is not in them — no devices, sensors, gadgets, lamps or ' +
      'other objects the room does not have.',
  );
  lines.push(
    '',
    `${STYLE}. The room fills most of the ${orientation === 'portrait' ? 'tall' : 'wide'} image, standing on its own ` +
      'on a transparent background — no floor, backdrop or shadow beyond the room itself.',
    '',
    'No text, no labels, no people, no watermark.',
  );
  return lines.join('\n');
}

/** The night picture, as an edit of the finished day picture. */
export const NIGHT_PROMPT = [
  'The image is a render of one room of a home, by day. Redraw the very same render at night.',
  '',
  'Keep everything exactly as it is: the camera angle and framing, the room, every wall, every piece of ' +
    'furniture, every material and colour, the composition. Only the light changes.',
  '',
  'Night: the windows show dark blue night outside; the daylight is gone and the room is dim. The room’s own ' +
    'lamps are on — the ceiling lights and any lamp in the room — casting warm, soft pools of light on the ' +
    'floor, the furniture and the walls near them, with soft falloff into shadow. Screens are off. The ' +
    'background around the room is a plain, flat, very dark charcoal with nothing on it. Moody, warm, quietly ' +
    'luxurious, like a premium smart-home app’s night mode.',
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
