import { describe, expect, it, vi } from 'vitest';
import { fetchLatestRelease, latestReleaseUrl, ReleaseFetchError, type ReleaseSource, shapeRelease } from './index.js';

const SOURCE: ReleaseSource = { repo: 'Super-Protocol/confidential-router', apiBaseUrl: 'https://api.github.test' };

const RELEASE = {
  tag_name: 'v0.4.1',
  html_url: 'https://github.com/Super-Protocol/confidential-router/releases/tag/v0.4.1',
  published_at: '2026-08-20T10:00:00.000Z',
  assets: [
    {
      name: 'gatekeeper_0.4.1_windows_amd64.zip',
      browser_download_url: 'https://example.test/win.zip',
      size: 9_000_000,
      content_type: 'application/zip',
    },
    {
      name: 'checksums.txt',
      browser_download_url: 'https://example.test/checksums.txt',
      size: 400,
      content_type: 'text/plain',
    },
    {
      name: 'gatekeeper_0.4.1_linux_amd64.tar.gz',
      browser_download_url: 'https://example.test/linux.tar.gz',
      size: 8_000_000,
      content_type: 'application/gzip',
    },
  ],
};

function respondWith(body: unknown, init: ResponseInit = {}): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200, ...init })) as unknown as typeof fetch;
}

describe('latestReleaseUrl', () => {
  it('does not double the slash when the base URL has a trailing one', () => {
    expect(latestReleaseUrl({ ...SOURCE, apiBaseUrl: 'https://api.github.test/' })).toBe(
      'https://api.github.test/repos/Super-Protocol/confidential-router/releases/latest',
    );
  });
});

describe('fetchLatestRelease', () => {
  it('returns the platform downloads, ordered, with the checksum manifest beside them', async () => {
    const release = await fetchLatestRelease(SOURCE, { fetcher: respondWith(RELEASE) });

    expect(release.version).toBe('v0.4.1');
    expect(release.publishedAt).toEqual(new Date('2026-08-20T10:00:00.000Z'));
    expect(release.checksumsUrl).toBe('https://example.test/checksums.txt');
    expect(release.downloads.map((download) => `${download.os}/${download.arch}`)).toEqual([
      'linux/amd64',
      'windows/amd64',
    ]);
    expect(release.downloads[0]).toMatchObject({ url: 'https://example.test/linux.tar.gz', sizeBytes: 8_000_000 });
  });

  it('sends a token when one is configured, and none when there is not', async () => {
    const fetcher = respondWith(RELEASE);
    await fetchLatestRelease({ ...SOURCE, token: 'ghp_x' }, { fetcher });
    await fetchLatestRelease(SOURCE, { fetcher });

    const headersOf = (call: number) =>
      (vi.mocked(fetcher).mock.calls[call][1] as RequestInit).headers as Record<string, string>;
    expect(headersOf(0).authorization).toBe('Bearer ghp_x');
    expect(headersOf(1).authorization).toBeUndefined();
  });

  it('degrades to notes-only rather than failing when a release publishes no assets', async () => {
    const release = await fetchLatestRelease(SOURCE, { fetcher: respondWith({ tag_name: 'v0.1.0' }) });

    expect(release.downloads).toEqual([]);
    expect(release.checksumsUrl).toBeNull();
    expect(release.publishedAt).toBeNull();
    // Nothing to link to means falling back to the canonical tag page, so the
    // screen always has somewhere to send the user.
    expect(release.notesUrl).toBe('https://github.com/Super-Protocol/confidential-router/releases/tag/v0.1.0');
  });

  it('refuses a release that names no version', async () => {
    await expect(fetchLatestRelease(SOURCE, { fetcher: respondWith({ assets: [] }) })).rejects.toBeInstanceOf(
      ReleaseFetchError,
    );
  });

  it('reports a rate-limited or missing repository as a fetch error', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 403 })) as unknown as typeof fetch;

    await expect(fetchLatestRelease(SOURCE, { fetcher })).rejects.toThrow(/returned 403/);
  });

  it('refuses a body larger than the budget instead of holding it', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify(RELEASE), { headers: { 'content-length': '999999999' } }),
    ) as unknown as typeof fetch;

    await expect(fetchLatestRelease(SOURCE, { fetcher })).rejects.toThrow(/byte budget/);
  });

  it('reports a body that is not JSON as a fetch error, not a parse crash', async () => {
    const fetcher = vi.fn(async () => new Response('<html>rate limited</html>')) as unknown as typeof fetch;

    await expect(fetchLatestRelease(SOURCE, { fetcher })).rejects.toThrow(/not JSON/);
  });
});

describe('shapeRelease', () => {
  it('survives a document whose fields are of the wrong type', () => {
    // GitHub's response is third-party input: a field of an unexpected type has
    // to degrade, not 500 the console's Gatekeeper screen.
    const release = shapeRelease(
      { tag_name: 'v9', assets: [{ name: 42, browser_download_url: null }, null, { name: 'x_linux_arm64.tar.gz' }] },
      SOURCE,
    );

    expect(release.downloads).toEqual([]);
    expect(release.version).toBe('v9');
  });

  it('falls back to the release name when there is no tag', () => {
    expect(shapeRelease({ name: 'v2.0.0' }, SOURCE).version).toBe('v2.0.0');
  });
});
