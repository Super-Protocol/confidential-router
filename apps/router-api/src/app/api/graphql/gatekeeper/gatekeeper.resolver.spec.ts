import { describe, expect, it, vi } from 'vitest';
import type { CachedRelease, GatekeeperReleaseService } from '../../../gatekeeper/index.js';
import { GatekeeperResolver } from './gatekeeper.resolver.js';

const RELEASE: CachedRelease = {
  version: 'v0.4.1',
  publishedAt: new Date('2026-08-20T10:00:00.000Z'),
  notesUrl: 'https://github.test/notes',
  checksumsUrl: 'https://github.test/checksums.txt',
  downloads: [
    {
      os: 'linux',
      arch: 'amd64',
      name: 'gatekeeper_0.4.1_linux_amd64.tar.gz',
      url: 'https://github.test/linux.tar.gz',
      sizeBytes: 8_000_000,
      contentType: 'application/gzip',
    },
  ],
  fetchedAt: new Date('2026-08-31T12:00:00.000Z'),
  stale: false,
};

function build(latest: () => Promise<CachedRelease | null>) {
  return new GatekeeperResolver({ latest } as unknown as GatekeeperReleaseService);
}

describe('GatekeeperResolver', () => {
  it('projects the release the service is holding', async () => {
    const release = await build(vi.fn().mockResolvedValue(RELEASE)).gatekeeperRelease();

    expect(release).toEqual({
      version: 'v0.4.1',
      publishedAt: new Date('2026-08-20T10:00:00.000Z'),
      notesUrl: 'https://github.test/notes',
      checksumsUrl: 'https://github.test/checksums.txt',
      downloads: [
        {
          os: 'linux',
          arch: 'amd64',
          name: 'gatekeeper_0.4.1_linux_amd64.tar.gz',
          url: 'https://github.test/linux.tar.gz',
          sizeBytes: 8_000_000,
          contentType: 'application/gzip',
        },
      ],
      fetchedAt: new Date('2026-08-31T12:00:00.000Z'),
      stale: false,
    });
  });

  it('passes the staleness through, so the screen can date its own links', async () => {
    const release = await build(vi.fn().mockResolvedValue({ ...RELEASE, stale: true })).gatekeeperRelease();

    expect(release?.stale).toBe(true);
  });

  it('answers null rather than an error when no release has been retrieved', async () => {
    // A repository with no release yet, or a first call that failed. The
    // Gatekeeper screen renders an empty state; it does not show an error.
    expect(await build(vi.fn().mockResolvedValue(null)).gatekeeperRelease()).toBeNull();
  });
});
