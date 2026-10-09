import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RegistryServer, startRegistryServer } from './registry-server.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REGISTRY_DIR = join(
  REPO_ROOT,
  'apps',
  'gatekeeper',
  'pkg',
  'attestation',
  'attestedroot',
  'testdata',
  'registry',
);
const APPS_448 =
  'sev-snp-azure/pre-release/mrenclave-74c75a0ba5f36e55548a14aa0dae0d0c9de9cd6ad041a4f6c553c996e2c579a7.json';

describe('registry server', () => {
  let registry: RegistryServer;
  beforeAll(async () => {
    registry = await startRegistryServer(REGISTRY_DIR);
  });
  afterAll(() => registry.close());

  // The one request the stand's gatekeeper makes that must hit: the committed
  // entry, byte for byte, under the path the real registry publishes it at.
  it('serves a committed entry at its registry path', async () => {
    const response = await fetch(`${registry.url}/${APPS_448}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(readFileSync(join(REGISTRY_DIR, APPS_448), 'utf8'));
  });

  // What the real host says for a measurement it does not sign, a channel that
  // does not exist yet, a directory, and a path that tries to leave the tree.
  it('answers 404 for everything else', async () => {
    for (const path of [
      '/sev-snp-azure/latest/mrenclave-74c75a0ba5f36e55548a14aa0dae0d0c9de9cd6ad041a4f6c553c996e2c579a7.json',
      '/sev-snp-azure/pre-release/mrenclave-bb6962eb20d616eb0f19479cf7fbccda50ee5682eab75b2104915d305a826aab.json',
      '/sev-snp-azure/pre-release/',
      '/',
      '/../README.md',
      '/..%2FREADME.md',
    ]) {
      const response = await fetch(`${registry.url}${path}`);
      expect(response.status, path).toBe(404);
    }
  });
});
