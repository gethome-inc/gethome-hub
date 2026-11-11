#!/usr/bin/env node
/**
 * Replays one room drawing — the day picture, the devices read off it, then
 * the night — against a fake provider, and prints what it costs this
 * process's memory: every second while it runs, and for three minutes after.
 *
 * **It spends nothing.** No request leaves the machine: OpenAI and Anthropic
 * are a `fetchImpl` answering in their own response shapes, with whatever
 * picture it is handed as the drawing. Everything else is the hub's own code —
 * `RoomPictureService` from a built `dist/`, writing real files — so this can
 * be pointed at the build installed on a hub as well as at a working tree.
 *
 * Why it exists: on a 512 MB board the hub sits about 15 MB under its
 * `MemoryHigh`, and on 2026-10-23 one drawing held it at that limit for four
 * minutes after the drawing had finished, which is what the memory-pressure
 * watch (`src/core/radio-pressure.ts`) stands Matter down for. Measure here
 * before and after any change to `src/room-pictures/`.
 *
 *   npm run build
 *   node --expose-gc scripts/replay-room-picture.mjs
 *
 * On a hub, as a separate process beside `gethome-hubd` and never instead of
 * it, with the service's own flags (`deploy/install.sh`) and its glibc
 * settings, in a scope of its own that the OOM killer reaches for first:
 *
 *   sudo systemd-run --scope --uid=pi --gid=pi -p MemoryMax=180M -p MemorySwapMax=0 -- \
 *     env MALLOC_MMAP_THRESHOLD_=131072 MALLOC_ARENA_MAX=2 choom -n 1000 -- \
 *     /opt/gethome/node/bin/node --optimize-for-size --max-semi-space-size=1 \
 *     --max-old-space-size=160 --expose-gc replay-room-picture.mjs \
 *     --dist /opt/gethome/current/dist --picture /tmp/day.png
 *
 * **Check which radios are live first.** With both up, the hub's pressure
 * watch votes on the board's `MemAvailable`, which this process lowers as
 * much as the hub would: three-quarters of an hour of replays beside a hub
 * with both radios up stood Matter down on 2026-10-26.
 *
 * `--expose-gc` lets the baseline start clean, and is also what lets the
 * store collect after a drawing, as it does on a 512 MB hub — leave it off to
 * replay a hub that cannot. `--gc-after` collects once more from here, for a
 * build older than that. Options:
 *
 *   --dist <dir>       the built hub to replay (default: ../dist)
 *   --data <dir>       where the pictures are written (default: a temporary
 *                      directory, removed at the end)
 *   --picture <png>    what the provider answers for the day (default: 2.3 MB
 *                      of random bytes, which base64 the same as a PNG)
 *   --night <png>      ...and for the night (default: 1.9 MB of random bytes)
 *   --photo <file>     a photo to send, repeatable (default: five random
 *                      400 KB "JPEGs" — the content is never decoded)
 *   --provider <name>  who reads the devices: openai (default) or anthropic
 *   --wait <s>         how long a drawing takes; a reading takes half (30)
 *   --after <s>        how long to keep watching once the night lands (180)
 *   --drawings <n>     draw the room this many times, one after another (1):
 *                      the first carries what is loaded once, so the second
 *                      is what a drawing really leaves behind
 *   --gap <s>          how long between drawings (60)
 *   --gc-after         collect garbage once the night lands
 *   --ballast <mb>     hold this much live heap first, to give V8's collector
 *                      a hub-sized heap to reason about (0)
 *   --csv <file>       write every sample there too
 */

import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values: options } = parseArgs({
  options: {
    dist: { type: 'string', default: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist') },
    data: { type: 'string' },
    picture: { type: 'string' },
    night: { type: 'string' },
    photo: { type: 'string', multiple: true },
    provider: { type: 'string', default: 'openai' },
    wait: { type: 'string', default: '30' },
    after: { type: 'string', default: '180' },
    drawings: { type: 'string', default: '1' },
    gap: { type: 'string', default: '60' },
    'gc-after': { type: 'boolean', default: false },
    ballast: { type: 'string', default: '0' },
    csv: { type: 'string' },
  },
});

const MB = 1024 * 1024;
/** What one socket read hands Node — the size the bodies move in. */
const CHUNK = 64 * 1024;
const waitMs = Number(options.wait) * 1000;
const afterMs = Number(options.after) * 1000;
const drawingCount = Math.max(1, Number(options.drawings));
const gapMs = Number(options.gap) * 1000;
const provider = options.provider === 'anthropic' ? 'anthropic' : 'openai';

const dist = path.resolve(options.dist);
const { RoomPictureService } = await import(pathToFileURL(path.join(dist, 'room-pictures/store.js')).href);
const { drawRoomPicture } = await import(pathToFileURL(path.join(dist, 'room-pictures/draw.js')).href);
const { locateDevices } = await import(pathToFileURL(path.join(dist, 'room-pictures/locate.js')).href);

// ── What the phone sends and what the providers answer ─────────────────────
// Built before the baseline is taken, so the fixtures are part of it and the
// numbers below are the drawing's alone.

const dayPng = options.picture ? readFileSync(options.picture) : randomBytes(Math.round(2.3 * MB));
const nightPng = options.night ? readFileSync(options.night) : randomBytes(Math.round(1.9 * MB));
const photos = options.photo?.length
  ? options.photo.map((file) => ({ bytes: readFileSync(file), type: /\.png$/i.test(file) ? 'image/png' : 'image/jpeg' }))
  : Array.from({ length: 5 }, () => ({ bytes: randomBytes(400 * 1024), type: 'image/jpeg' }));

const devices = [
  { id: 'replay-light', name: 'Ceiling light', kind: 'light' },
  { id: 'replay-lamp', name: 'Floor lamp', kind: 'light' },
  { id: 'replay-plug', name: 'Kettle plug', kind: 'outlet' },
  { id: 'replay-sensor', name: 'Climate sensor', kind: 'sensor' },
];
const points = devices.map((device, index) => ({ id: device.id, x: 0.2 + index * 0.15, y: 0.4, seen: index % 2 === 0 }));

/** `POST /room-pictures`, as the app sends it: the photos as base64 in JSON. */
const requestBody = Buffer.from(
  JSON.stringify({
    roomId: '00000000-0000-4000-8000-000000000000',
    orientation: 'portrait',
    photos: photos.map((photo) => ({ data: photo.bytes.toString('base64'), type: photo.type })),
  }),
);

/** The Image API's answer to `/v1/images/edits` with a GPT Image model. */
const imageAnswer = (png) =>
  Buffer.from(
    JSON.stringify({
      created: 1_761_400_000,
      background: 'transparent',
      data: [{ b64_json: png.toString('base64') }],
      output_format: 'png',
      quality: 'high',
      size: '1024x1536',
      usage: {
        input_tokens: 5_000,
        input_tokens_details: { image_tokens: 4_480, text_tokens: 520 },
        output_tokens: 6_240,
        total_tokens: 11_240,
      },
    }),
  );
const dayAnswer = imageAnswer(dayPng);
const nightAnswer = imageAnswer(nightPng);

/** The Responses API's answer, or the Messages API's, to the reading. */
const locateAnswer = Buffer.from(
  JSON.stringify(
    provider === 'openai'
      ? {
          id: 'resp_replay',
          object: 'response',
          status: 'completed',
          output: [
            { id: 'rs_replay', type: 'reasoning', summary: [] },
            {
              id: 'msg_replay',
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', annotations: [], text: JSON.stringify({ devices: points }) }],
            },
          ],
          usage: {
            input_tokens: 2_100,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 400,
            output_tokens_details: { reasoning_tokens: 300 },
            total_tokens: 2_500,
          },
        }
      : {
          id: 'msg_replay',
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Reading the room.', signature: 'replay' },
            { type: 'tool_use', id: 'toolu_replay', name: 'submit_points', input: { devices: points } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 2_100, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
  ),
);

/**
 * The providers. The request is serialised exactly as `fetch` would send it —
 * a FormData becomes its multipart stream, a string its UTF-8 — and read out to
 * the end; the answer comes back in fresh socket-sized chunks after the wait.
 */
let edits = 0;
const fetchImpl = async (url, init) => {
  const request = new Request(url, init);
  if (request.body) for await (const _chunk of request.body);
  const isEdit = String(url).endsWith('/images/edits');
  const answer = isEdit ? (edits++ % 2 === 0 ? dayAnswer : nightAnswer) : locateAnswer;
  await sleep(isEdit ? waitMs : waitMs / 2);
  let at = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (at >= answer.length) return controller.close();
      controller.enqueue(new Uint8Array(answer.subarray(at, at + CHUNK)));
      at += CHUNK;
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
};

// ── Watching ───────────────────────────────────────────────────────────────

/** This process's cgroup, when there is one to read (Linux, cgroup v2). */
const cgroupFile = (() => {
  try {
    const line = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((entry) => entry.startsWith('0::'));
    if (!line) return undefined;
    const file = path.join('/sys/fs/cgroup', line.slice(3), 'memory.current');
    readFileSync(file);
    return file;
  } catch {
    return undefined;
  }
})();

function rssAnon() {
  try {
    const match = /RssAnon:\s+(\d+) kB/.exec(readFileSync('/proc/self/status', 'utf8'));
    return match ? Number(match[1]) * 1024 : undefined;
  } catch {
    return undefined;
  }
}

function cgroup() {
  try {
    return cgroupFile ? Number(readFileSync(cgroupFile, 'utf8')) : undefined;
  } catch {
    return undefined;
  }
}

const COLUMNS = ['rss', 'anon', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers', 'cgroup'];
const started = Date.now();
let phase = 'load';
const samples = [];
const peaks = {};
const raise = (sample, columns) => {
  for (const column of columns) if (sample[column] !== undefined) peaks[column] = Math.max(peaks[column] ?? 0, sample[column]);
};

function measure() {
  const usage = process.memoryUsage();
  return {
    t: (Date.now() - started) / 1000,
    phase,
    rss: usage.rss,
    anon: rssAnon(),
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    cgroup: cgroup(),
  };
}

const mb = (bytes) => (bytes === undefined || Number.isNaN(bytes) ? '–' : (bytes / MB).toFixed(1)).padStart(6);
const header = `${'t'.padStart(5)}  ${'phase'.padEnd(8)}${COLUMNS.map((column) => column.slice(0, 6).padStart(7)).join('')}`;

function record() {
  const sample = measure();
  samples.push(sample);
  raise(sample, COLUMNS);
  console.log(`${sample.t.toFixed(0).padStart(5)}  ${sample.phase.padEnd(8)}${COLUMNS.map((column) => ` ${mb(sample[column])}`).join('')}`);
  if (options.csv) appendFileSync(options.csv, `${[sample.t, sample.phase, ...COLUMNS.map((column) => sample[column] ?? '')].join(',')}\n`);
  return sample;
}

/** Peaks between the printed samples, which a one-second clock would miss. */
const fine = setInterval(() => {
  raise(measure(), ['rss', 'heapUsed', 'external', 'arrayBuffers']);
}, 100);

// ── The drawing ────────────────────────────────────────────────────────────

const data = options.data ?? mkdtempSync(path.join(tmpdir(), 'gethome-replay-'));
if (options.csv) writeFileSync(options.csv, `t,phase,${COLUMNS.join(',')}\n`);

// On the global object: a module-level binding nothing reads after an `await`
// is not kept across it, and the collector takes it.
const ballastBytes = Number(options.ballast) * MB;
globalThis.replayBallast = [];
if (ballastBytes > 0) {
  const floor = process.memoryUsage().heapUsed;
  for (let index = 0; process.memoryUsage().heapUsed - floor < ballastBytes; index++) {
    for (let inner = 0; inner < 1_000; inner++) {
      globalThis.replayBallast.push({ id: `device-${index}-${inner}`, values: [index, inner, index * inner] });
    }
  }
}

console.log(`node ${process.version} ${process.execArgv.join(' ')}`);
const malloc = Object.entries(process.env).filter(([name]) => name.startsWith('MALLOC_'));
if (malloc.length) console.log(malloc.map(([name, value]) => `${name}=${value}`).join(' '));
console.log(`dist ${dist}`);
console.log(
  `photos ${photos.length} × ${(photos.reduce((sum, photo) => sum + photo.bytes.length, 0) / photos.length / 1024).toFixed(0)} KB, ` +
    `day ${(dayPng.length / MB).toFixed(2)} MB, night ${(nightPng.length / MB).toFixed(2)} MB, ` +
    `reading by ${provider}, ${waitMs / 1000}s a drawing${ballastBytes ? `, ${options.ballast} MB ballast` : ''}`,
);
console.log(`all figures MB\n${header}`);

globalThis.gc?.();
await sleep(1_000);
phase = 'baseline';
const baseline = [record(), (await sleep(1_000), record()), (await sleep(1_000), record())].at(-1);
const ticker = setInterval(record, 1_000);

const service = new RoomPictureService(
  data,
  undefined,
  { warn: (fields, message) => console.warn(`  ! ${message}`, fields?.err?.message ?? '') },
  undefined,
  // Space is not what is being measured, and a nearly full disk would stop it.
  { minFreeBytes: 0 },
  (input) => {
    phase = edits % 2 === 0 ? 'day' : 'night';
    return drawRoomPicture({ ...input, fetchImpl });
  },
  (input) => {
    phase = 'locate';
    return locateDevices({ ...input, fetchImpl });
  },
);

/** The state each drawing ended in: when its night landed, and as the next began. */
const landings = [];
const lasting = [];
let answered;
for (let drawing = 1; drawing <= drawingCount; drawing++) {
  if (drawing > 1) {
    phase = 'between';
    await sleep(gapMs);
    lasting.push(record());
  }
  // What the route does before the store sees anything (`POST /room-pictures`
  // in src/api/server.ts): Fastify gathers the body as a string, parses it,
  // and each photo is decoded — the parsed body held until the answer is sent.
  phase = 'request';
  let held;
  {
    const decoder = new StringDecoder('utf8');
    let text = '';
    for (let at = 0; at < requestBody.length; at += CHUNK) text += decoder.write(Buffer.from(requestBody.subarray(at, at + CHUNK)));
    held = JSON.parse(text + decoder.end());
  }
  answered = await service.draw({
    roomId: held.roomId,
    roomName: 'Living room',
    orientation: held.orientation,
    photos: held.photos.map((photo) => ({ bytes: Buffer.from(photo.data, 'base64'), contentType: photo.type })),
    devices,
    apiKey: 'replay',
    locator: async () => ({ provider, modelId: provider === 'openai' ? 'replay-openai' : 'replay-anthropic', apiKey: 'replay' }),
  });
  held = undefined;
  await service.settled();
  landings.push(record());
  if (options['gc-after']) {
    if (typeof globalThis.gc === 'function') globalThis.gc();
    else console.warn('  ! --gc-after needs --expose-gc; nothing was collected.');
  }
}
const landed = landings.at(-1);
phase = 'after';
await sleep(afterMs);
clearInterval(ticker);
clearInterval(fine);
const end = record();
lasting.push(end);

const finished = service.get(answered.id);
console.log(
  `\n${drawingCount > 1 ? `${drawingCount} drawings; the last ` : ''}drew ${finished?.hasNight ? 'day and night' : 'the day only'}, ` +
    `${finished?.markers.length ?? 0} markers, ${((finished?.bytes ?? 0) / MB).toFixed(2)} MB written`,
);
const at = (seconds) => samples.find((sample) => sample.t >= landed.t + seconds) ?? end;
const numbered = (label, index) => (drawingCount > 1 ? `${label} ${index + 1}` : label);
const rows = [
  ['baseline', baseline],
  ['peak', peaks],
  ...landings.slice(0, -1).flatMap((sample, index) => [
    [numbered('night landed', index), sample],
    [numbered('next began', index), lasting[index]],
  ]),
  [numbered('night landed', landings.length - 1), landed],
  ['+30 s', at(30)],
  ['+60 s', at(60)],
  [`+${Math.round(end.t - landed.t)} s (end)`, end],
];
const label = (text) => text.padEnd(18);
console.log(`${label('')}${COLUMNS.map((column) => column.slice(0, 6).padStart(7)).join('')}`);
for (const [name, sample] of rows) console.log(`${label(name)}${COLUMNS.map((column) => ` ${mb(sample[column])}`).join('')}`);
// What each drawing left behind, measured as the next one began (and at the
// end, for the last): the first carries what is loaded once, the rest are
// what a drawing costs for as long as it is remembered.
lasting.forEach((sample, index) => {
  const before = index === 0 ? baseline : lasting[index - 1];
  console.log(`${label(numbered('held by drawing', index))}${COLUMNS.map((column) => ` ${mb(sample[column] - before[column])}`).join('')}`);
});

if (!options.data) rmSync(data, { recursive: true, force: true });
