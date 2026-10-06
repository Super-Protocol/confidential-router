import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ConfigType } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDataSource, seedExternalEndpoint, seedTrustedMeasurement } from '../../../test/seed.js';
import type { routerConfig } from '../config.js';
import { RouterConfigSchema } from '../config.schema.js';
import { ExternalEndpoint } from '../db/entities/external-endpoint.entity.js';
import { SidecarConfigWriterService } from './sidecar-config-writer.service.js';

const MEASUREMENT = 'a'.repeat(64);

let dataSource: DataSource;
let dir: string;
let configFile: string;

beforeEach(async () => {
  dataSource = await createTestDataSource();
  dir = mkdtempSync(join(tmpdir(), 'cr-sidecar-'));
  configFile = join(dir, 'nested', 'gatekeeper', 'config.yaml');
});

afterEach(async () => {
  await dataSource.destroy();
  rmSync(dir, { recursive: true, force: true });
});

function writer(): SidecarConfigWriterService {
  const config = RouterConfigSchema.parse({
    auth: { secret: 'a'.repeat(32) },
    externalEndpoints: { configFile, adminListen: '127.0.0.1:9465', reattestInterval: '10m' },
  }) as ConfigType<typeof routerConfig>;
  return new SidecarConfigWriterService(config, dataSource);
}

describe('render', () => {
  it('writes the file on the first pass, creating the directory the volume mounts at', async () => {
    const endpoint = await seedExternalEndpoint(dataSource, { status: 'pending' });
    await seedTrustedMeasurement(dataSource, MEASUREMENT);

    const result = await writer().render();

    expect(result).toEqual({ changed: true, endpoints: 1, trustedMeasurements: 1 });
    const rendered = readFileSync(configFile, 'utf8');
    expect(rendered).toContain(`name: ${endpoint.name}`);
    expect(rendered).toContain(MEASUREMENT);
  });

  it('renders a pending endpoint, because that is how it stops being pending', async () => {
    // A row only reaches `verified` by the sidecar attesting it, which it can only
    // do once the endpoint is in its config. Waiting for a verdict before
    // rendering would be a deadlock.
    await seedExternalEndpoint(dataSource, { status: 'pending' });

    await writer().render();

    expect(readFileSync(configFile, 'utf8')).toContain('trust: cloud-measurement');
  });

  it('leaves a disabled endpoint out entirely', async () => {
    // Not rendered-and-stopped: an endpoint the sidecar has never heard of cannot
    // be reached by a stale verdict.
    const disabled = await seedExternalEndpoint(dataSource, { enabled: false });

    const result = await writer().render();

    expect(result.endpoints).toBe(0);
    expect(readFileSync(configFile, 'utf8')).not.toContain(disabled.name);
  });

  it('does not rewrite the file when nothing changed', async () => {
    // The sidecar reloads on a change and a reload force-re-attests every
    // surviving endpoint, so an idle render must be a no-op.
    await seedExternalEndpoint(dataSource);
    const service = writer();

    await expect(service.render()).resolves.toMatchObject({ changed: true });
    await expect(service.render()).resolves.toMatchObject({ changed: false });
  });

  it('rewrites the file when the trust list changes', async () => {
    await seedExternalEndpoint(dataSource);
    const service = writer();
    await service.render();

    await seedTrustedMeasurement(dataSource, MEASUREMENT);

    await expect(service.render()).resolves.toMatchObject({ changed: true });
    expect(readFileSync(configFile, 'utf8')).toContain(MEASUREMENT);
  });

  it('is not disturbed by a status poll ticking lastCheckedAt', async () => {
    // Verdict columns are not part of the sidecar's config, so projecting one
    // must not look like a mutation and trigger a reload.
    const endpoint = await seedExternalEndpoint(dataSource);
    const service = writer();
    await service.render();

    await dataSource
      .getRepository(ExternalEndpoint)
      .update({ id: endpoint.id }, { status: 'verified', lastCheckedAt: new Date(), updatedAt: new Date() });

    await expect(service.render()).resolves.toMatchObject({ changed: false });
  });

  it('replaces the file by rename, leaving no temporary behind', async () => {
    await seedExternalEndpoint(dataSource);

    await writer().render();

    const directory = join(dir, 'nested', 'gatekeeper');
    expect(readdirSync(directory)).toEqual(['config.yaml']);
  });

  it('overwrites whatever a previous version of this code left at the path', async () => {
    mkdirSync(dirname(configFile), { recursive: true });
    writeFileSync(configFile, 'version: 1\n# stale\n', 'utf8');
    await seedExternalEndpoint(dataSource);

    await expect(writer().render()).resolves.toMatchObject({ changed: true });
    expect(readFileSync(configFile, 'utf8')).not.toContain('stale');
  });

  it('renders an empty config on a deployment with no external endpoints', async () => {
    // Every deployment boots this, including the ones that never register one.
    const result = await writer().render();

    expect(result).toEqual({ changed: true, endpoints: 0, trustedMeasurements: 0 });
    expect(readFileSync(configFile, 'utf8')).toContain('endpoints: []');
  });
});

describe('onApplicationBootstrap', () => {
  it('renders at boot, so a restart hands the sidecar the database as it stands', async () => {
    await seedExternalEndpoint(dataSource);

    await writer().onApplicationBootstrap();

    expect(readFileSync(configFile, 'utf8')).toContain('trust: cloud-measurement');
  });

  it('does not stop the service booting when the render fails', async () => {
    // With no file the sidecar serves nothing, which is the fail-closed state
    // anyway; refusing to boot would turn a misconfigured path into an outage of
    // the whole API, including the console that would explain it.
    await seedExternalEndpoint(dataSource);
    // A regular file where the config's directory should be, so `mkdir` cannot
    // succeed and nor can anything after it.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, '', 'utf8');
    const config = RouterConfigSchema.parse({
      auth: { secret: 'a'.repeat(32) },
      externalEndpoints: { configFile: join(blocker, 'config.yaml'), adminListen: '127.0.0.1:9465' },
    }) as ConfigType<typeof routerConfig>;
    const service = new SidecarConfigWriterService(config, dataSource);

    await expect(service.render()).rejects.toThrow();
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
