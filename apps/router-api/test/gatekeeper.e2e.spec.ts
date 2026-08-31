import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './app-harness.js';
import { anonymous, type ConsoleSession, expectData, graphql, signIn } from './console.js';

/**
 * The Gatekeeper screen against the real application: a stub GitHub API serves a
 * release, the console reads the download list, and the router keeps serving
 * those links when GitHub stops answering.
 */

const RELEASE = `
  query {
    gatekeeperRelease {
      version
      publishedAt
      notesUrl
      checksumsUrl
      stale
      downloads { name os arch sizeBytes contentType url }
    }
  }
`;

const RELEASE_BODY = {
  tag_name: 'v0.4.1',
  html_url: 'https://github.test/Super-Protocol/confidential-router/releases/tag/v0.4.1',
  published_at: '2026-08-20T10:00:00.000Z',
  assets: [
    {
      name: 'gatekeeper_0.4.1_darwin_arm64.tar.gz',
      browser_download_url: 'https://github.test/dl/darwin-arm64.tar.gz',
      size: 7_500_000,
      content_type: 'application/gzip',
    },
    {
      name: 'checksums.txt',
      browser_download_url: 'https://github.test/dl/checksums.txt',
      size: 512,
      content_type: 'text/plain',
    },
    {
      name: 'gatekeeper_0.4.1_linux_amd64.tar.gz',
      browser_download_url: 'https://github.test/dl/linux-amd64.tar.gz',
      size: 8_200_000,
      content_type: 'application/gzip',
    },
    {
      name: 'gatekeeper_0.4.1_linux_amd64.tar.gz.sig',
      browser_download_url: 'https://github.test/dl/linux-amd64.tar.gz.sig',
      size: 96,
      content_type: 'application/octet-stream',
    },
  ],
};

let github: Server;
let port: number;
let calls = 0;
/** Flipped by a test to make the stub behave like a rate-limited GitHub. */
let refusing = false;

beforeAll(async () => {
  github = createServer((req, res) => {
    calls += 1;
    if (refusing) {
      res.writeHead(403, { 'content-type': 'application/json' }).end('{"message":"API rate limit exceeded"}');
      return;
    }
    if (req.url === '/repos/Super-Protocol/confidential-router/releases/latest') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(RELEASE_BODY));
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((resolve) => github.listen(0, '127.0.0.1', resolve));
  port = (github.address() as AddressInfo).port;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => github?.close(() => resolve()));
});

function gatekeeperConfig(cacheTtl: string, repo = 'Super-Protocol/confidential-router') {
  return { version: 1, gatekeeper: { repo, apiBaseUrl: `http://127.0.0.1:${port}`, cacheTtl } };
}

describe('the Gatekeeper screen', () => {
  let harness: Harness;
  let session: ConsoleSession;

  beforeAll(async () => {
    // Long enough that this suite decides when a refresh happens rather than the
    // clock; the unit tests own the ageing behaviour.
    harness = await createHarness({ config: gatekeeperConfig('15m') });
    session = await signIn(harness, 'gatekeeper@example.com');
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('lists one download per platform, ordered, with the checksum manifest beside them', async () => {
    const { gatekeeperRelease } = await expectData(session, RELEASE);

    expect(gatekeeperRelease).toMatchObject({
      version: 'v0.4.1',
      publishedAt: '2026-08-20T10:00:00.000Z',
      notesUrl: 'https://github.test/Super-Protocol/confidential-router/releases/tag/v0.4.1',
      checksumsUrl: 'https://github.test/dl/checksums.txt',
      stale: false,
    });
    // The signature file is not a download button; the manifest is a link.
    expect(gatekeeperRelease.downloads).toEqual([
      {
        name: 'gatekeeper_0.4.1_linux_amd64.tar.gz',
        os: 'LINUX',
        arch: 'AMD64',
        sizeBytes: 8_200_000,
        contentType: 'application/gzip',
        url: 'https://github.test/dl/linux-amd64.tar.gz',
      },
      {
        name: 'gatekeeper_0.4.1_darwin_arm64.tar.gz',
        os: 'MACOS',
        arch: 'ARM64',
        sizeBytes: 7_500_000,
        contentType: 'application/gzip',
        url: 'https://github.test/dl/darwin-arm64.tar.gz',
      },
    ]);
  });

  it('serves the cached release rather than calling GitHub per page load', async () => {
    const before = calls;

    await expectData(session, RELEASE);
    await expectData(session, RELEASE);

    expect(calls).toBe(before);
  });

  it('describes an artefact and nothing else', async () => {
    // ADR-002: the router publishes evidence and never learns that a gatekeeper
    // verified anything. An instance list, a registration or a status field
    // here would be the first crack in that, so the type is asserted whole.
    const { __type } = await expectData(session, '{ __type(name: "GatekeeperRelease") { fields { name } } }');

    expect((__type.fields as { name: string }[]).map((field) => field.name).sort()).toEqual([
      'checksumsUrl',
      'downloads',
      'fetchedAt',
      'notesUrl',
      'publishedAt',
      'stale',
      'version',
    ]);
  });

  it('is refused without a session', async () => {
    const body = await graphql(anonymous(harness), RELEASE);

    expect(body.errors[0].message).toMatch(/Authentication is required/);
    expect(body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });
});

describe('when GitHub stops answering', () => {
  let harness: Harness;
  let session: ConsoleSession;

  beforeAll(async () => {
    // No cache window, so every query is a refresh and this suite can watch one
    // fail without waiting for a TTL.
    harness = await createHarness({ config: gatekeeperConfig('0s') });
    session = await signIn(harness, 'gatekeeper-degraded@example.com');
  }, 60_000);

  afterAll(async () => {
    refusing = false;
    await harness?.close();
  });

  it('keeps the last known links and dates them, rather than emptying the screen', async () => {
    await expectData(session, RELEASE);
    refusing = true;

    const { gatekeeperRelease } = await expectData(session, RELEASE);

    expect(gatekeeperRelease.stale).toBe(true);
    expect(gatekeeperRelease.version).toBe('v0.4.1');
    expect(gatekeeperRelease.downloads).toHaveLength(2);
  });

  it('recovers on its own once GitHub answers again', async () => {
    refusing = true;
    await expectData(session, RELEASE);
    refusing = false;

    const { gatekeeperRelease } = await expectData(session, RELEASE);

    expect(gatekeeperRelease.stale).toBe(false);
  });
});

describe('a repository that has published nothing', () => {
  let harness: Harness;
  let session: ConsoleSession;

  beforeAll(async () => {
    harness = await createHarness({ config: gatekeeperConfig('15m', 'Super-Protocol/no-such-repo') });
    session = await signIn(harness, 'gatekeeper-empty@example.com');
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('answers null, so the screen renders an empty state instead of an error', async () => {
    const { gatekeeperRelease } = await expectData(session, RELEASE);

    expect(gatekeeperRelease).toBeNull();
  });
});
