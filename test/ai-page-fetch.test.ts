import { describe, expect, it } from 'vitest';
import {
  FETCHABLE_HOSTS,
  fetchDocumentationPage,
  isPrivateAddress,
  toText,
  type LookupFn,
} from '../src/ai/page-fetch.js';

/**
 * The one place the hub reaches a site that is not a provider's API, so the
 * guards are the whole of what makes it acceptable.
 *
 * The URL comes from model output and the fetch happens on a box inside
 * somebody's home network — a general fetch tool here would be a
 * request-forgery primitive aimed at the LAN, dressed up as research. Each of
 * these is a different way past the allowlist.
 */

/**
 * A resolver that always answers with a public address.
 *
 * Injected so this suite touches no network: a guard whose test needs DNS to
 * be working is one CI cannot check on an offline runner, and the resolver is
 * not what any of these cases are about.
 */
const publicDns: LookupFn = async () => [{ address: '185.199.108.153' }];

/** A fetch that answers whatever the case needs and records what it was asked
 *  for, so a test can prove a request was never made at all. */
const stubFetch = (
  responder: (url: URL) => Response,
): { impl: typeof fetch; calls: string[] } => {
  const calls: string[] = [];
  const impl = (async (input: URL | Request | string) => {
    const url = input instanceof URL ? input : new URL(String(input));
    calls.push(url.href);
    return responder(url);
  }) as typeof fetch;
  return { impl, calls };
};

const page = (body: string, init?: ResponseInit) => new Response(body, init);

describe('what the hub will fetch', () => {
  it('reads a device page on an allowed host', async () => {
    const { impl, calls } = stubFetch(() =>
      page('<html><body><h1>SP-EUC01</h1><p>power in W</p></body></html>'),
    );
    const result = await fetchDocumentationPage(
      'https://www.zigbee2mqtt.io/devices/SP-EUC01.html',
      { fetchImpl: impl, lookupImpl: publicDns },
    );

    expect(result.ok).toBe(true);
    expect(result.text).toContain('SP-EUC01');
    expect(result.text).toContain('power in W');
    // Markup is noise here; the prose is the point.
    expect(result.text).not.toContain('<h1>');
    expect(calls).toHaveLength(1);
  });

  it('reads the converter source, which is the other half of the answer', async () => {
    const { impl } = stubFetch(() => page('const definition = { model: "SP-EUC01" };'));
    const result = await fetchDocumentationPage(
      'https://raw.githubusercontent.com/Koenkk/zigbee-herdsman-converters/master/src/devices/lumi.ts',
      { fetchImpl: impl, lookupImpl: publicDns },
    );
    expect(result.ok).toBe(true);
    expect(result.text).toContain('SP-EUC01');
  });

  /**
   * The LAN cases, and the reason the allowlist exists at all. None of these
   * may result in a request — asserting on `calls` rather than on the refusal
   * is what proves the guard ran *before* the fetch and not after it.
   */
  it.each([
    ['the hub’s own API', 'https://127.0.0.1:8420/api/v1/hub'],
    ['a router', 'https://192.168.1.1/'],
    ['a private range', 'https://10.0.0.5/admin'],
    ['cloud metadata', 'https://169.254.169.254/latest/meta-data/'],
    ['any other site', 'https://example.com/'],
  ])('refuses %s without making a request', async (_case, url) => {
    const { impl, calls } = stubFetch(() => page('should never be reached'));
    const result = await fetchDocumentationPage(url, { fetchImpl: impl, lookupImpl: publicDns });

    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
    // A refusal the model can act on, not "not allowed".
    for (const host of FETCHABLE_HOSTS) expect(result.text).toContain(host);
  });

  /**
   * `endsWith('zigbee2mqtt.io')` would accept this, which is why the match is
   * the host exactly or a subdomain *with the dot*.
   */
  it('refuses a lookalike host', async () => {
    const { impl, calls } = stubFetch(() => page('nope'));
    const result = await fetchDocumentationPage('https://evil-zigbee2mqtt.io/devices/x.html', {
      fetchImpl: impl,
      lookupImpl: publicDns,
    });
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('accepts a real subdomain of an allowed host', async () => {
    const { impl } = stubFetch(() => page('ok'));
    const result = await fetchDocumentationPage('https://www.zigbee2mqtt.io/index.html', {
      fetchImpl: impl,
      lookupImpl: publicDns,
    });
    expect(result.ok).toBe(true);
  });

  it('refuses plaintext, so there is no hop to hijack', async () => {
    const { impl, calls } = stubFetch(() => page('nope'));
    const result = await fetchDocumentationPage('http://www.zigbee2mqtt.io/devices/x.html', {
      fetchImpl: impl,
      lookupImpl: publicDns,
    });
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  /**
   * **The one a plain allowlist misses.** `fetch` follows redirects itself, so
   * an allowed host answering `302 http://10.0.0.1/` would walk straight past
   * the check. Every hop is re-examined instead.
   */
  it('re-checks every redirect hop rather than following it', async () => {
    const { impl, calls } = stubFetch((url) =>
      url.hostname === 'www.zigbee2mqtt.io'
        ? page('', { status: 302, headers: { location: 'https://10.0.0.1/secrets' } })
        : page('LAN'),
    );
    const result = await fetchDocumentationPage('https://www.zigbee2mqtt.io/devices/x.html', {
      fetchImpl: impl,
      lookupImpl: publicDns,
    });

    expect(result.ok).toBe(false);
    expect(result.text).not.toContain('LAN');
    // The first hop happened; the second never did.
    expect(calls).toEqual(['https://www.zigbee2mqtt.io/devices/x.html']);
  });

  it('follows a redirect that stays on an allowed host', async () => {
    const { impl, calls } = stubFetch((url) =>
      url.pathname === '/old'
        ? page('', { status: 301, headers: { location: '/devices/x.html' } })
        : page('the device page'),
    );
    const result = await fetchDocumentationPage('https://www.zigbee2mqtt.io/old', {
      fetchImpl: impl,
      lookupImpl: publicDns,
    });
    expect(result.ok).toBe(true);
    expect(result.text).toContain('the device page');
    expect(calls).toHaveLength(2);
  });

  it('stops a redirect loop instead of running out the run', async () => {
    const { impl, calls } = stubFetch(() =>
      page('', { status: 302, headers: { location: 'https://www.zigbee2mqtt.io/round' } }),
    );
    const result = await fetchDocumentationPage('https://www.zigbee2mqtt.io/round', {
      fetchImpl: impl,
      lookupImpl: publicDns,
    });
    expect(result.ok).toBe(false);
    expect(calls.length).toBeLessThanOrEqual(4);
  });

  /**
   * A 404 is the expected answer for a page the hub named from a model string,
   * so it has to point at what to do next rather than read as a fault.
   */
  it('names the way forward on a 404', async () => {
    const { impl } = stubFetch(() => page('not found', { status: 404 }));
    const result = await fetchDocumentationPage('https://www.zigbee2mqtt.io/devices/NOPE.html', {
      fetchImpl: impl,
      lookupImpl: publicDns,
    });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/named differently/i);
  });

  /** A 403 or a 502 is the site, not the name — sending a run to look for a
   *  differently-named page would be a wrong diagnosis. */
  it('does not blame the URL for a status that is not about the URL', async () => {
    const { impl } = stubFetch(() => page('blocked', { status: 403 }));
    const result = await fetchDocumentationPage('https://www.zigbee2mqtt.io/devices/x.html', {
      fetchImpl: impl,
      lookupImpl: publicDns,
    });
    expect(result.ok).toBe(false);
    expect(result.text).toContain('403');
    expect(result.text).not.toMatch(/named differently/i);
  });

  /**
   * The other allowed host serves *source*, not markup, and an HTML pass over
   * a converter definition eats its `<` and `>` and flattens the indentation
   * for nothing.
   */
  it('leaves non-markup alone', async () => {
    const source = 'const x: Array<number> = [1];\n  // if (a < b && c > d) …';
    const { impl } = stubFetch(() =>
      page(source, { headers: { 'content-type': 'text/plain; charset=utf-8' } }),
    );
    const result = await fetchDocumentationPage(
      'https://raw.githubusercontent.com/Koenkk/zigbee-herdsman-converters/master/src/devices/lumi.ts',
      { fetchImpl: impl, lookupImpl: publicDns },
    );
    expect(result.text).toBe(source.trim());
  });

  it('still strips a page that does not say what it is', async () => {
    const { impl } = stubFetch(() => page('<p>Power is in <b>W</b>.</p>'));
    const result = await fetchDocumentationPage('https://www.zigbee2mqtt.io/devices/x.html', {
      fetchImpl: impl,
      lookupImpl: publicDns,
    });
    expect(result.text).not.toContain('<b>');
    expect(result.text).toContain('Power is in');
  });

  it('never throws — a tool result must not end a paid run', async () => {
    const impl = (async () => {
      throw new Error('ECONNRESET');
    }) as typeof fetch;
    const result = await fetchDocumentationPage('https://www.zigbee2mqtt.io/devices/x.html', {
      fetchImpl: impl,
      lookupImpl: publicDns,
    });
    expect(result.ok).toBe(false);
    expect(result.text).toContain('ECONNRESET');
  });

  it('refuses something that is not a URL at all', async () => {
    const { impl, calls } = stubFetch(() => page('nope'));
    expect((await fetchDocumentationPage('the zigbee page', { fetchImpl: impl, lookupImpl: publicDns })).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('bounds what it hands back, and says it did', async () => {
    const { impl } = stubFetch(() => page(`<p>${'word '.repeat(60_000)}</p>`));
    const result = await fetchDocumentationPage('https://www.zigbee2mqtt.io/devices/big.html', {
      fetchImpl: impl,
      lookupImpl: publicDns,
    });
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(40_000);
  });
});

describe('is this address one the hub may reach', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fd00::1',
    '::ffff:192.168.1.1',
    'not-an-address',
  ])('refuses %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(['1.1.1.1', '185.199.108.153', '8.8.8.8', '2606:4700::1111', '172.32.0.1', '172.15.0.1'])(
    'allows %s',
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );
});

describe('markup to text', () => {
  it('drops scripts and styles whole, keeping the prose', () => {
    const text = toText(
      '<style>.a{color:red}</style><script>alert(1)</script><p>Power is in <b>W</b>.</p>',
    );
    expect(text).toContain('Power is in');
    expect(text).toContain('W');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color:red');
  });

  it('keeps a table readable line by line', () => {
    const text = toText('<tr><td>power</td></tr><tr><td>energy</td></tr>');
    expect(text.split('\n').map((line) => line.trim())).toEqual(['power', 'energy']);
  });

  it('decodes the entities documentation actually uses', () => {
    expect(toText('<p>0 &lt; x &amp; y &gt; 1 &quot;ON&quot;</p>')).toBe('0 < x & y > 1 "ON"');
  });
});
