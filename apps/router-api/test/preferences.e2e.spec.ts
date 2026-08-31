import JSZip from 'jszip';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './app-harness.js';
import { anonymous, type ConsoleSession, dataSourceOf, expectData, graphql, signIn } from './console.js';
import { type Catalog, seedCatalog, seedGeneration } from './seed.js';

// The Preferences screen reads through the viewer, so one query loads the whole
// screen and a setting has exactly one place it can come from.
const PREFERENCES = `
  query { me { preferences { archiveEvidence evidenceRetentionDays notifyOnMeasurementChange desktopNotifications emailReceipts } } }
`;

const UPDATE = `
  mutation Update($input: UpdatePreferencesInput!) {
    updatePreferences(input: $input) { archiveEvidence evidenceRetentionDays emailReceipts }
  }
`;

const EXPORT = `
  mutation Export($workspaceId: ID!, $from: DateTime!, $to: DateTime!) {
    exportEvidence(workspaceId: $workspaceId, from: $from, to: $to) { url expiresAt }
  }
`;

let harness: Harness;
let session: ConsoleSession;
let catalog: Catalog;

beforeAll(async () => {
  harness = await createHarness();
  session = await signIn(harness, 'preferences@example.com');
  const dataSource = dataSourceOf(harness);
  catalog = { ...(await seedCatalog(dataSource)), workspaceId: session.workspaceId };
  await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-29T09:00:00Z'), covered: true });
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

describe('preferences', () => {
  it('answers with the defaults before anything has been changed', async () => {
    const data = await expectData(session, PREFERENCES);

    expect(data.me.preferences).toEqual({
      archiveEvidence: true,
      evidenceRetentionDays: 90,
      notifyOnMeasurementChange: true,
      desktopNotifications: false,
      emailReceipts: true,
    });
  });

  it('stores what was sent and leaves the rest alone', async () => {
    await expectData(session, UPDATE, { input: { archiveEvidence: false } });
    const data = await expectData(session, UPDATE, { input: { evidenceRetentionDays: 365 } });

    expect(data.updatePreferences).toEqual({
      archiveEvidence: false,
      evidenceRetentionDays: 365,
      emailReceipts: true,
    });
  });

  it('rejects a retention window outside its bounds', async () => {
    const body = await graphql(session, UPDATE, { input: { evidenceRetentionDays: 100_000 } });

    expect(body.errors).toBeDefined();
  });

  it('keeps one user out of another’s settings', async () => {
    const other = await signIn(harness, 'preferences-other@example.com');
    const data = await expectData(other, PREFERENCES);

    expect(data.me.preferences.archiveEvidence).toBe(true);
  });

  it('is refused without a session', async () => {
    const body = await graphql(anonymous(harness), PREFERENCES);

    expect(body.errors[0].message).toMatch(/Authentication is required/);
  });
});

describe('the evidence export', () => {
  /** `responseType('blob')` is what makes supertest buffer the zip rather than decode it as text. */
  function download(path: string) {
    return request(harness.app.getHttpServer()).get(path).responseType('blob').expect(200);
  }

  async function link(): Promise<string> {
    const data = await expectData(session, EXPORT, {
      workspaceId: session.workspaceId,
      from: '2026-08-28T00:00:00.000Z',
      to: '2026-08-31T00:00:00.000Z',
    });
    const url = new URL(data.exportEvidence.url);
    return `${url.pathname}${url.search}`;
  }

  it('returns an expiring link rather than the bytes', async () => {
    const data = await expectData(session, EXPORT, {
      workspaceId: session.workspaceId,
      from: '2026-08-28T00:00:00.000Z',
      to: '2026-08-31T00:00:00.000Z',
    });

    expect(data.exportEvidence.url).toContain('/exports/evidence.zip?token=');
    expect(new Date(data.exportEvidence.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('serves a zip of what the endpoints published, to whoever holds the link', async () => {
    // No cookie: the point of the export is that it can be handed to an auditor.
    const response = await download(await link());

    expect(response.headers['content-type']).toMatch(/application\/zip/);
    const archive = await JSZip.loadAsync(response.body);
    const names = Object.values(archive.files)
      .filter((file) => !file.dir)
      .map((file) => file.name);
    expect(names).toContain('manifest.json');
    expect(names).toContain(`snapshots/${catalog.snapshotId}/bundle.json`);
  });

  it('says in the archive that the router never verified any of it', async () => {
    const response = await download(await link());
    const archive = await JSZip.loadAsync(response.body);
    const manifest = JSON.parse((await archive.file('manifest.json')?.async('string')) ?? '{}');

    expect(manifest.note).toMatch(/never verifies/);
  });

  it('refuses a request with no token, and one with a forged token', async () => {
    await request(harness.app.getHttpServer()).get('/exports/evidence.zip').expect(401);
    await request(harness.app.getHttpServer()).get('/exports/evidence.zip?token=a.b').expect(401);
  });

  it('refuses to mint a link for a workspace the caller cannot see', async () => {
    const other = await signIn(harness, 'export-stranger@example.com');

    const body = await graphql(other, EXPORT, {
      workspaceId: session.workspaceId,
      from: '2026-08-28T00:00:00.000Z',
      to: '2026-08-31T00:00:00.000Z',
    });

    expect(body.errors[0].message).toMatch(/do not have access/i);
  });

  it('refuses a backwards range', async () => {
    const body = await graphql(session, EXPORT, {
      workspaceId: session.workspaceId,
      from: '2026-08-31T00:00:00.000Z',
      to: '2026-08-28T00:00:00.000Z',
    });

    expect(body.errors).toBeDefined();
  });
});
