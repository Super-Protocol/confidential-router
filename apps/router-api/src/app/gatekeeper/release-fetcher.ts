/**
 * Retrieval of the gatekeeper's published release from GitHub.
 *
 * Retrieval and shaping only — the caching, the staleness and the "what does
 * the console see when GitHub is down" question live in the service.
 */

import { type ClassifiedAsset, classifyAsset, compareAssets, isChecksums } from './release-assets.js';

/**
 * A release is a few kilobytes of JSON. The cap is two orders of magnitude
 * above that and exists so a misbehaving or hijacked mirror cannot make the
 * router allocate without bound.
 */
export const MAX_RELEASE_BYTES = 256 * 1024;

export class ReleaseFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseFetchError';
  }
}

export interface GatekeeperDownload extends ClassifiedAsset {
  name: string;
  url: string;
  sizeBytes: number;
  contentType: string;
}

export interface PublishedRelease {
  version: string;
  publishedAt: Date | null;
  notesUrl: string;
  /** GoReleaser's checksum manifest, so a download can be verified offline. */
  checksumsUrl: string | null;
  downloads: GatekeeperDownload[];
}

export interface ReleaseSource {
  /** `owner/repo` on GitHub. */
  repo: string;
  apiBaseUrl: string;
  /** Optional: the anonymous GitHub API is rate-limited per source IP. */
  token?: string;
}

export interface FetchReleaseOptions {
  timeoutMs?: number;
  fetcher?: typeof fetch;
  maxBytes?: number;
}

export function latestReleaseUrl(source: ReleaseSource): string {
  return `${source.apiBaseUrl.replace(/\/+$/, '')}/repos/${source.repo}/releases/latest`;
}

/** Fetches the latest release and shapes it, or throws `ReleaseFetchError`. */
export async function fetchLatestRelease(
  source: ReleaseSource,
  options: FetchReleaseOptions = {},
): Promise<PublishedRelease> {
  const url = latestReleaseUrl(source);
  const fetcher = options.fetcher ?? globalThis.fetch;
  const maxBytes = options.maxBytes ?? MAX_RELEASE_BYTES;

  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    // GitHub rejects an API request that sends none.
    'user-agent': 'confidential-router',
  };
  if (source.token) {
    headers.authorization = `Bearer ${source.token}`;
  }

  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      redirect: 'follow',
    });
  } catch (error) {
    throw new ReleaseFetchError(`GET ${url} failed: ${(error as Error).message}`);
  }

  if (!response.ok) {
    throw new ReleaseFetchError(`GET ${url} returned ${response.status}`);
  }

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ReleaseFetchError(`GET ${url} declared ${declared} bytes, over the ${maxBytes} byte budget`);
  }

  const body = await response.text();
  if (body.length > maxBytes) {
    throw new ReleaseFetchError(`GET ${url} returned more than ${maxBytes} bytes`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new ReleaseFetchError(`GET ${url} returned a body that is not JSON: ${(error as Error).message}`);
  }

  return shapeRelease(parsed, source);
}

interface GitHubAsset {
  name?: unknown;
  browser_download_url?: unknown;
  size?: unknown;
  content_type?: unknown;
}

/**
 * Turns GitHub's release document into the few fields the screen renders.
 *
 * Every field is read defensively: this is a third-party document, and a
 * missing `assets` array must degrade to "no downloads, here are the notes"
 * rather than to a 500 on the console's Gatekeeper screen.
 */
export function shapeRelease(document: unknown, source: ReleaseSource): PublishedRelease {
  const release = (document ?? {}) as {
    tag_name?: unknown;
    name?: unknown;
    html_url?: unknown;
    published_at?: unknown;
    assets?: unknown;
  };

  const version = stringOr(release.tag_name, '') || stringOr(release.name, '');
  if (!version) {
    throw new ReleaseFetchError('the release names no version');
  }

  const assets = Array.isArray(release.assets)
    ? (release.assets as unknown[]).flatMap((asset) =>
        asset && typeof asset === 'object' ? [asset as GitHubAsset] : [],
      )
    : [];
  const downloads = assets
    .flatMap((asset): GatekeeperDownload[] => {
      const name = stringOr(asset.name, '');
      const url = stringOr(asset.browser_download_url, '');
      const classified = name && url ? classifyAsset(name) : null;
      if (!classified) {
        return [];
      }
      return [
        {
          ...classified,
          name,
          url,
          sizeBytes: Number.isSafeInteger(asset.size) ? (asset.size as number) : 0,
          contentType: stringOr(asset.content_type, 'application/octet-stream'),
        },
      ];
    })
    .sort(compareAssets);

  const checksums = assets.find((asset) => isChecksums(stringOr(asset.name, '')));
  const publishedAt = new Date(stringOr(release.published_at, 'invalid'));

  return {
    version,
    publishedAt: Number.isNaN(publishedAt.getTime()) ? null : publishedAt,
    // Falls back to the canonical tag URL: a release with no `html_url` is a
    // malformed document, not a reason to leave the screen without a link.
    notesUrl: stringOr(release.html_url, '') || `https://github.com/${source.repo}/releases/tag/${version}`,
    checksumsUrl: (checksums && stringOr(checksums.browser_download_url, '')) || null,
    downloads,
  };
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}
