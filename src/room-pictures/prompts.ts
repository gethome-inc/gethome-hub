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
 * **The room's own colours, in daylight — and never rearranged.** The room is
 * drawn as a 3D artist's model of itself: its real colours, materials and
 * textures, soft daylight from its own windows, crisp geometry and fine detail,
 * seen from one corner with the two near walls removed. Those are the words the
 * first pictures were drawn from, and they came back on 2026-11-10. From
 * 2026-10-23 until then the look was a designed one — the palette softened
 * and unified into off-whites and taupes, patterns calmed to solid tones, even
 * studio light, the walls' cut tops in a light tone, the far corner held at the
 * top centre and the room filling the image edge to edge — and one room drawn
 * both ways from the same photos made the case against it. The designed one
 * was paler and flatter: its windows blank where the other's let the day in,
 * its floor and fabrics without their grain and pattern, its outline lost on a
 * white page for want of the darker wall tops, and a long room bent to fit a
 * view that suits a square one. What makes a room a pleasure to look at turned
 * out to be what makes it recognisable. **That pair was also drawn a model
 * apart** — the first on 2.5 Sunburst, the designed one on 2.6 — so how much
 * of the difference was the words alone is not measured, and these words have
 * not been compared on 2.6 either: if a room drawn from them still comes out
 * flat, the model is what is left to compare, on the same photos, before any
 * more is changed here. What it may not do is move anything, which the designed
 * version said best and which stays in its words: every piece of furniture,
 * door and window stands where the photos show it, at its size and against its
 * wall, since that is what makes it this room, and what the devices' markers
 * are placed by — and whatever stands against the two removed walls stays, cut
 * low, because a draft without that line left a kitchen counter out.
 *
 * **Flattered a little, in how things look and never in where they stand.** A
 * room need not be drawn one to one: it is drawn on its best day — each thing
 * the best-kept version of itself, clean and unworn, fabrics smooth, colours a
 * touch richer than a phone photo of them, a television showing a landscape
 * rather than a black slab. None of the earlier words said so outright. The
 * first asked only for clutter to be tidied away; the designed look meant it
 * and said it as a softer palette, which is how beautiful came out as pale.
 * So it is said here in so many words, and pointed at the surface of things.
 * The line it stops at is the two paragraphs around it. Nothing is restyled
 * or swapped for a better one, because the room has to be recognised; nothing
 * is moved, because the markers are placed by where things stand; and nothing
 * is added, because the picture is then read for the home's devices and an
 * invented lamp is somewhere a light's marker would be stood.
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
  'Soft, diffuse daylight from the windows — a room with no window is lit as softly from above — gentle ambient ' +
  'occlusion, soft contact shadows, matte materials with a subtle sheen, crisp clean geometry, walls cut as thick ' +
  'clean sections with a slightly darker top edge, a thin floor slab under the room. Calm, tidy and quietly ' +
  'luxurious, highly detailed';

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
      'seen into like a dollhouse, the two far walls standing full height. Choose the corner that shows the most of ' +
      'the room — the windows and the main furniture against the two far walls.',
    '',
    'A 3D artist’s model of this very room: its real shape and proportions, in the room’s real colours, materials ' +
      'and textures — the floor, the wall paint, the furniture, the fabrics and their patterns, the appliances, the ' +
      'curtains — so the person who lives here recognises their own room at a glance.',
    '',
    'Flatter the room a little, as a good 3D artist would: each thing is the best-kept version of itself — clean, ' +
      'fresh and well made, with no wear, stains or dust — fabrics smooth, cushions and curtains sitting neatly, a ' +
      'bed made, colours a touch richer and cleaner than the photos show, and a television’s screen may show a calm ' +
      'landscape rather than stand black. It is the room on its best day and still this room: flatter what is ' +
      'there, never restyle it or swap a thing for a better one.',
    '',
    'The layout is exact: every piece of furniture, every appliance, every door, window and fixture stands where ' +
      'the photos show it, at its real size, facing the way it faces, against the same wall. Nothing is moved, ' +
      'swapped, added or left out — whatever stands against the two removed walls stays, cut away low at the front ' +
      'like the walls themselves. Tidy away clutter, laundry, bags, cables and mess, and ignore the photos’ dim ' +
      'lighting and colour casts.',
    '',
    'Draw only what the photos show. Add nothing that is not in them — no devices, sensors, gadgets, lamps or ' +
      'other objects the room does not have.',
  );
  lines.push(
    '',
    `${STYLE}. The room fills most of the ${orientation === 'portrait' ? 'tall' : 'wide'} image, standing on its ` +
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
