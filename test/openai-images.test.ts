import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PORTRAIT_MODEL, drawPortrait, portraitCostUsd } from '../src/portraits/openai-images.js';

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

  it('uses GPT Image 2.5 Flare with a transparent PNG background for a generated portrait', async () => {
    await expect(drawPortrait({ apiKey: 'sk-proj-test', prompt: 'A smart wall plug.' })).resolves.toEqual({
      png: Buffer.from('portrait'),
    });

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
    expect(PORTRAIT_MODEL).toBe('gpt-image-2.5-flare');
  });

  it('uses the GPT Image 2.5 Flare edits endpoint when a photo is supplied', async () => {
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

  /**
   * What a drawing cost is read off the provider's own answer rather than
   * estimated from the size and quality we asked for — 2.5 bills per token, so
   * the response is the only thing that actually knows.
   */
  it('reads the token usage back off the response and prices it', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ b64_json: Buffer.from('portrait').toString('base64') }],
          usage: {
            input_tokens: 210,
            output_tokens: 4160,
            input_tokens_details: { text_tokens: 200, image_tokens: 10 },
          },
        }),
        { status: 200 },
      ),
    );

    const drawing = await drawPortrait({ apiKey: 'sk-proj-test', prompt: 'A smart wall plug.' });
    expect(drawing.usage).toEqual({ inputTextTokens: 200, inputImageTokens: 10, outputTokens: 4160 });
    // 200 text @ $5, 10 image @ $8, 4160 output @ $30, per million.
    expect(portraitCostUsd(drawing.usage)).toBeCloseTo((200 * 5 + 10 * 8 + 4160 * 30) / 1_000_000, 10);
  });

  /**
   * The half that must never round to zero: `$0.00` is a claim, and "the
   * provider said nothing" is the truth. `ai_runs` holds the same line for a
   * conversation whose spend row has been pruned.
   */
  it('prices a drawing the provider reported no usage for as unknown, never as free', async () => {
    const drawing = await drawPortrait({ apiKey: 'sk-proj-test', prompt: 'A smart wall plug.' });
    expect(drawing.usage).toBeUndefined();
    expect(portraitCostUsd(drawing.usage)).toBeUndefined();
  });

  /**
   * Without the breakdown there is no way to tell a prompt from a reference
   * photo, so the whole input is priced at the dearer image rate — the
   * direction `mostExpensive()` picks in `models.ts`, since an estimate that
   * reads low is the one that surprises somebody.
   */
  it('prices an unsplit input at the image rate rather than the cheaper text one', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ b64_json: Buffer.from('portrait').toString('base64') }],
          usage: { input_tokens: 300, output_tokens: 1000 },
        }),
        { status: 200 },
      ),
    );

    const drawing = await drawPortrait({ apiKey: 'sk-proj-test', prompt: 'A smart wall plug.' });
    expect(drawing.usage).toEqual({ inputTextTokens: 0, inputImageTokens: 300, outputTokens: 1000 });
    expect(portraitCostUsd(drawing.usage)).toBeCloseTo((300 * 8 + 1000 * 30) / 1_000_000, 10);
  });
});
