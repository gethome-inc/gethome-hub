import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PORTRAIT_MODEL, drawPortrait } from '../src/portraits/openai-images.js';

describe('OpenAI portrait generation', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('portrait').toString('base64') }] }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses GPT Image 2 with a transparent PNG background for a generated portrait', async () => {
    await expect(drawPortrait({ apiKey: 'sk-proj-test', prompt: 'A smart wall plug.' })).resolves.toEqual(
      Buffer.from('portrait'),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/images/generations');
    expect(init.headers).toMatchObject({ authorization: 'Bearer sk-proj-test', 'content-type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual({
      model: PORTRAIT_MODEL,
      prompt: 'A smart wall plug.',
      size: '1024x1024',
      n: 1,
      background: 'transparent',
      output_format: 'png',
      quality: 'high',
    });
    expect(PORTRAIT_MODEL).toBe('gpt-image-2');
  });

  it('uses the GPT Image 2 edits endpoint when a photo is supplied', async () => {
    await drawPortrait({
      apiKey: 'sk-proj-test',
      prompt: 'Restyle this device.',
      photo: { bytes: Buffer.from('photo'), contentType: 'image/jpeg' },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/images/edits');
    expect(init.headers).toMatchObject({ authorization: 'Bearer sk-proj-test' });
    const form = init.body as FormData;
    expect(form.get('model')).toBe(PORTRAIT_MODEL);
    expect(form.get('background')).toBe('transparent');
    // Transparency is only honoured on an alpha-capable format, and the store
    // writes these bytes to a `.png` the route serves as `image/png`.
    expect(form.get('output_format')).toBe('png');
    expect(form.get('image')).toBeInstanceOf(Blob);
    // And no `content-type` of our own on the multipart path: setting one
    // would omit the boundary `fetch` generates, and the upload would fail.
    expect(init.headers).not.toHaveProperty('content-type');
  });
});
