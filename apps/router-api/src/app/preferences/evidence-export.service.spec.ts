import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import JSZip from 'jszip';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Catalog,
  createTestDataSource,
  seedCatalog,
  seedExternalEndpoint,
  seedExternalSnapshot,
  seedGeneration,
  testConfig,
} from '../../../test/seed.js';
import { Generation } from '../db/entities/generation.entity.js';
import { ExternalEvidenceService } from '../external-endpoints/external-evidence.service.js';
import { EvidenceExportService } from './evidence-export.service.js';

const FROM = new Date('2026-08-28T00:00:00Z');
const TO = new Date('2026-08-31T00:00:00Z');

let dataSource: DataSource;
let exports: EvidenceExportService;
let catalog: Catalog;

beforeEach(async () => {
  dataSource = await createTestDataSource();
  exports = new EvidenceExportService(dataSource, testConfig(), new ExternalEvidenceService(dataSource));
  catalog = await seedCatalog(dataSource);
});

afterEach(async () => {
  await dataSource.destroy();
});

function request() {
  return { userId: 'user-1', workspaceId: catalog.workspaceId, from: FROM, to: TO };
}

/** File names only: JSZip synthesises a directory entry per path segment. */
async function entries(): Promise<string[]> {
  const archive = await JSZip.loadAsync(await exports.build(catalog.workspaceId, FROM, TO));
  return Object.values(archive.files)
    .filter((file) => !file.dir)
    .map((file) => file.name)
    .sort();
}

/** The manifest of an export over the test period. */
async function manifest(): Promise<{
  note: string;
  origins: Record<string, string>;
  generations: { served: number; covered: number };
  snapshots: { id: string; endpoint: string; origin: string; evidenceDigest: string; generations: number }[];
  unretrieved: { endpoint: string; origin: string; evidenceDigest: string; generations: number }[];
}> {
  const archive = await JSZip.loadAsync(await exports.build(catalog.workspaceId, FROM, TO));
  return JSON.parse((await archive.file('manifest.json')?.async('string')) ?? '{}');
}

const UPSTREAM_DIGEST = 'sha256/upstream-bundle';

describe('the export link', () => {
  it('round-trips its claims', () => {
    // `verifyToken` reads the real clock, so the link has to be minted against it.
    const now = new Date();
    const link = exports.link(request(), now);
    const token = new URL(link.url).searchParams.get('token') ?? '';

    expect(exports.verifyToken(token)).toMatchObject({
      workspaceId: catalog.workspaceId,
      userId: 'user-1',
      from: FROM.getTime(),
      to: TO.getTime(),
    });
    expect(link.expiresAt.getTime()).toBe(now.getTime() + 15 * 60 * 1000);
  });

  it('refuses a token nobody signed', () => {
    expect(() => exports.verifyToken('made.up')).toThrow(UnauthorizedException);
  });

  it('refuses a backwards range before minting anything', () => {
    expect(() => exports.link({ ...request(), from: TO, to: FROM })).toThrow(BadRequestException);
  });
});

describe('the archive', () => {
  it('contains the bundle and the JWS of every snapshot the period used', async () => {
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-29T09:00:00Z'), covered: true });

    expect(await entries()).toEqual([
      'manifest.json',
      `snapshots/${catalog.snapshotId}/bundle.json`,
      `snapshots/${catalog.snapshotId}/evidence.jws`,
    ]);
  });

  it('lists each snapshot once, with how many generations referenced it', async () => {
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-29T09:00:00Z'), covered: true });
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-29T10:00:00Z'), covered: true });

    const archive = await JSZip.loadAsync(await exports.build(catalog.workspaceId, FROM, TO));
    const manifest = JSON.parse((await archive.file('manifest.json')?.async('string')) ?? '{}');

    expect(manifest.snapshots).toHaveLength(1);
    expect(manifest.snapshots[0]).toMatchObject({ id: catalog.snapshotId, generations: 2 });
  });

  it('says in the manifest that nothing in it is a verdict', async () => {
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-29T09:00:00Z'), covered: true });

    const { note } = await manifest();

    expect(note).toMatch(/not a verdict/);
    expect(note).toMatch(/gatekeeper/);
    // ADR-002: nothing in this product records a verdict, including its exports.
    expect(JSON.stringify(await manifest())).not.toMatch(/"(valid|verified|trusted)"/);
  });

  /*
   * The note used to be one sentence — "what the platform published", "never
   * verifies it" — and once external entries were in the zip it was wrong about
   * half of them: an upstream's bundle was published by the upstream, and it was
   * matched by a digest this router's egress leg verified. The archive states
   * that itself rather than leaving it to the contract doc.
   */
  it('says, per origin, who published a document and what matched it', async () => {
    const upstream = await seedExternalEndpoint(dataSource, { status: 'verified', withModel: false });
    await seedExternalSnapshot(dataSource, upstream.id, UPSTREAM_DIGEST);
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-29T09:00:00Z'), covered: true });
    await seedGeneration(dataSource, catalog, {
      createdAt: new Date('2026-08-29T10:00:00Z'),
      externalEndpointId: upstream.id,
      evidenceDigest: UPSTREAM_DIGEST,
    });

    const { note, origins } = await manifest();

    expect(Object.keys(origins).sort()).toEqual(['external', 'own']);
    expect(origins.own).toMatch(/Published by this deployment/);
    expect(origins.own).toMatch(/does not verify its own evidence/);
    // The two facts a single note could not carry: someone else published it,
    // and what matched it to a generation was a verification this router did.
    expect(origins.external).toMatch(/not by this deployment/);
    expect(origins.external).toMatch(/verified that upstream/);
    // And the note no longer claims one provenance for both.
    expect(note).not.toMatch(/never verifies/);
    expect(note).not.toMatch(/what the platform published/);
  });

  it('explains only the origins the archive actually carries', async () => {
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-29T09:00:00Z'), covered: true });

    expect(Object.keys((await manifest()).origins)).toEqual(['own']);
  });

  /*
   * SUP-295 item 4. Every generation on a deployment that serves someone else's
   * models goes through an external endpoint, and none of them carries an
   * `evidenceSnapshotId` — there is no row to stamp when the request is served.
   * Keying the export on that column alone produced `"snapshots": []` for a
   * workspace that had been chatting all month, which is the one failure mode an
   * evidence export must not have.
   */
  it('covers a generation an external upstream served, through the digest its verdict saw', async () => {
    const upstream = await seedExternalEndpoint(dataSource, { status: 'verified', withModel: false });
    const snapshotId = await seedExternalSnapshot(dataSource, upstream.id, UPSTREAM_DIGEST);
    await seedGeneration(dataSource, catalog, {
      createdAt: new Date('2026-08-29T09:00:00Z'),
      externalEndpointId: upstream.id,
      evidenceDigest: UPSTREAM_DIGEST,
    });

    expect(await entries()).toEqual([
      'manifest.json',
      `snapshots/${snapshotId}/bundle.json`,
      `snapshots/${snapshotId}/evidence.jws`,
    ]);
    const { snapshots } = await manifest();
    expect(snapshots).toMatchObject([
      { id: snapshotId, endpoint: upstream.name, origin: 'external', evidenceDigest: UPSTREAM_DIGEST, generations: 1 },
    ]);
  });

  it('carries both origins at once, and says which is which', async () => {
    const upstream = await seedExternalEndpoint(dataSource, { status: 'verified', withModel: false });
    await seedExternalSnapshot(dataSource, upstream.id, UPSTREAM_DIGEST);
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-29T09:00:00Z'), covered: true });
    await seedGeneration(dataSource, catalog, {
      createdAt: new Date('2026-08-29T10:00:00Z'),
      externalEndpointId: upstream.id,
      evidenceDigest: UPSTREAM_DIGEST,
    });

    const { snapshots, generations } = await manifest();

    expect(snapshots.map((snapshot) => snapshot.origin).sort()).toEqual(['external', 'own']);
    expect(generations).toEqual({ served: 2, covered: 2 });
  });

  it('files one upstream’s publication under its own digest and no one else’s', async () => {
    // Both upstreams are read in one query, so the pairing has to be re-applied:
    // a cross product would hand each of them the other's bundle.
    const first = await seedExternalEndpoint(dataSource, { status: 'verified', withModel: false });
    const second = await seedExternalEndpoint(dataSource, { status: 'verified', withModel: false });
    const firstSnapshot = await seedExternalSnapshot(dataSource, first.id, UPSTREAM_DIGEST);
    await seedExternalSnapshot(dataSource, second.id, 'sha256/other-bundle');
    await seedGeneration(dataSource, catalog, {
      createdAt: new Date('2026-08-29T09:00:00Z'),
      externalEndpointId: first.id,
      evidenceDigest: UPSTREAM_DIGEST,
    });
    await seedGeneration(dataSource, catalog, {
      createdAt: new Date('2026-08-29T10:00:00Z'),
      externalEndpointId: second.id,
      // The digest the *first* upstream published, observed on the second. Nothing
      // may be handed out for it: the bundle on file belongs to another host.
      evidenceDigest: UPSTREAM_DIGEST,
    });

    const { snapshots, unretrieved } = await manifest();

    expect(snapshots).toMatchObject([{ id: firstSnapshot, endpoint: first.name, generations: 1 }]);
    expect(unretrieved).toMatchObject([{ endpoint: second.name, evidenceDigest: UPSTREAM_DIGEST, generations: 1 }]);
  });

  it('names a digest it holds no bundle for rather than dropping the generation', async () => {
    // The upstream had already republished by the time the evidence poller asked,
    // so the publication the verdict named is gone. The digest is still what an
    // auditor takes to that upstream.
    const upstream = await seedExternalEndpoint(dataSource, { status: 'verified', withModel: false });
    await seedGeneration(dataSource, catalog, {
      createdAt: new Date('2026-08-29T09:00:00Z'),
      externalEndpointId: upstream.id,
      evidenceDigest: UPSTREAM_DIGEST,
    });

    const { snapshots, unretrieved, generations } = await manifest();

    expect(snapshots).toEqual([]);
    expect(unretrieved).toMatchObject([
      { endpoint: upstream.name, origin: 'external', evidenceDigest: UPSTREAM_DIGEST, generations: 1 },
    ]);
    // The number that makes an empty archive readable: one generation served,
    // none of it covered by a bundle this router holds.
    expect(generations).toEqual({ served: 1, covered: 0 });
  });

  it('counts what the period served, so an empty archive can be told from a quiet month', async () => {
    expect(await manifest()).toMatchObject({ generations: { served: 0, covered: 0 }, snapshots: [] });

    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-29T09:00:00Z'), covered: false });

    expect(await manifest()).toMatchObject({ generations: { served: 1, covered: 0 }, snapshots: [] });
  });

  /*
   * The two origin queries partition the period structurally rather than by
   * convention. The recorder cannot write a row that is both today, but no
   * invariant forbids one — `generationEndpointIsExclusive` says nothing about
   * `evidenceSnapshotId` — and counting such a row twice would push
   * `generations.covered` above `served`, turning the signal that reports a
   * fault into a fault of its own.
   */
  it('counts a row that is somehow both origins once, on the external side', async () => {
    const upstream = await seedExternalEndpoint(dataSource, { status: 'verified', withModel: false });
    await seedExternalSnapshot(dataSource, upstream.id, UPSTREAM_DIGEST);
    await seedGeneration(dataSource, catalog, {
      createdAt: new Date('2026-08-29T09:00:00Z'),
      externalEndpointId: upstream.id,
      evidenceDigest: UPSTREAM_DIGEST,
    });
    // Written behind the recorder's back, which is the only way it can exist.
    await dataSource
      .getRepository(Generation)
      .update({ externalEndpointId: upstream.id }, { evidenceSnapshotId: catalog.snapshotId });

    const { snapshots, generations } = await manifest();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ origin: 'external', generations: 1 });
    expect(generations).toEqual({ served: 1, covered: 1 });
  });

  it('skips generations that had no published evidence', async () => {
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-29T09:00:00Z'), covered: false });

    expect(await entries()).toEqual(['manifest.json']);
  });

  it('ignores generations outside the period, and other workspaces', async () => {
    const other = await seedCatalog(dataSource);
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-09-05T09:00:00Z'), covered: true });
    await seedGeneration(dataSource, other, { createdAt: new Date('2026-08-29T09:00:00Z'), covered: true });

    expect(await entries()).toEqual(['manifest.json']);
  });
});
