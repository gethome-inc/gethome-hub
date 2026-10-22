/**
 * The words a room picture is drawn from.
 *
 * **The clay model is the picture's skeleton and the photos are its skin.**
 * The first image is the app's own render of the room in plain clay, from the
 * camera the app will show the picture through — so the room has to come back
 * exactly as large and exactly where it was, or the app's device markers would
 * stand beside the things they belong to. The photos say what everything looks
 * like. Each image's role is named, because an image model given a pile of
 * pictures blends them.
 *
 * **The shape is the scan's; the furniture is the photos'.** A scan measures a
 * room well and recognises its furniture less well — a wardrobe read as two
 * pillars, a chair that is not there. So walls, openings and the camera are
 * held exactly, and the furniture is held as a guide: where the photos show
 * something else in that place, the photos win.
 *
 * **Day, then night as an edit of the day.** The night is the same picture
 * with the light changed, which is what lets the apps cross from one to the
 * other with nothing moving — and why it is drawn from the finished day rather
 * than from the clay a second time.
 */

const STYLE =
  'the room render of a premium smart-home app: an isometric cutaway of the room as a 3D artist would model it. ' +
  'Soft, diffuse daylight from the windows, gentle ambient occlusion, soft contact shadows, matte materials with a ' +
  'subtle sheen, crisp clean geometry, walls cut as thick clean sections with a slightly darker top edge, a thin ' +
  'floor slab under the room. Calm, tidy and quietly luxurious, highly detailed';

/** The day picture, from the clay model and — when there are any — photos. */
export function dayPrompt(roomName: string, photoCount: number): string {
  const subject = roomName.trim().length > 0 ? `“${roomName.trim()}”` : 'one room';
  const lines = [
    `The first image is a plain clay 3D model of ${subject}, a room of a real home, seen from above at an isometric ` +
      'angle and cut away like a dollhouse: the walls nearest the viewer are removed so the room can be seen into.',
  ];
  if (photoCount > 0) {
    lines.push(
      'The other images are phone photos of this same room. Ignore any white guide lines, buttons, small 3D ' +
        'previews and other on-screen overlays in them.',
    );
  }
  lines.push(
    '',
    `Redraw the first image as ${STYLE}. The room stands on its own on a transparent background — no floor, ` +
      'backdrop or shadow beyond the room itself.',
    '',
    'Keep exactly as the first image has them: the camera angle, the room exactly as large and in exactly the ' +
      'same place in the image, the shape of the room, which walls stand and where they are cut away, and the ' +
      'window and door openings.',
  );
  if (photoCount > 0) {
    lines.push(
      '',
      'The furniture in the first image was measured by a scanner and is a guide to where things stand: keep ' +
        'each piece where it is and about as big, but draw what the photos show there — the real sofa, table, ' +
        'cabinets and appliances. Where the photos show that a block in the model is something else, draw what ' +
        'the photos show; where nothing in the photos stands there, leave it out.',
      '',
      'Take from the photos the room’s real colours, materials and textures, so the person who lives here ' +
        'recognises their own room at a glance: the floor, the wall paint, the cabinets and worktops, the ' +
        'appliances, the fabrics, the curtains, the lamps. Tidy away clutter, bags and mess, and ignore the ' +
        'photos’ dim lighting and colour casts.',
    );
  } else {
    lines.push(
      '',
      'Keep every piece of furniture where the first image has it and as big. There are no photos of this room, ' +
        'so dress it in calm, realistic, neutral materials that suit what the room is for.',
    );
  }
  lines.push('', 'No text, no labels, no people, no watermark.');
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
