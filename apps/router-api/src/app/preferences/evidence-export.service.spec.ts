import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import JSZip from 'jszip';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Catalog, createTestDataSource, seedCatalog, seedGeneration, testConfig } from '../../../test/seed.js';
import { EvidenceExportService } from './evidence-export.service.js';

const FROM = new Date('2026-08-28T00:00:00Z');
const TO = new Date('2026-08-31T00:00:00Z');

let dataSource: DataSource;
let exports: EvidenceExportService;
let catalog: Catalog;

beforeEach(async () => {
  dataSource = await createTestDataSource();
  exports = new EvidenceExportService(dataSource, testConfig());
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

  it('says in the manifest that the router never verified any of it', async () => {
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-29T09:00:00Z'), covered: true });

    const archive = await JSZip.loadAsync(await exports.build(catalog.workspaceId, FROM, TO));
    const manifest = JSON.parse((await archive.file('manifest.json')?.async('string')) ?? '{}');

    expect(manifest.note).toMatch(/never verifies/);
    // ADR-002: nothing in this product records a verdict, including its exports.
    expect(JSON.stringify(manifest)).not.toMatch(/"(valid|verified|trusted)"/);
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
