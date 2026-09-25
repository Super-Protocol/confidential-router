/**
 * Invitation codes against the built artefact.
 *
 * `apps/router-api/test/invites.e2e.spec.ts` covers the behaviour in process.
 * What only a real build can show is here, and it is the part most likely to
 * break silently: `dist/cli/invites.js` is a second webpack entry point, so it
 * can stop existing — or stop being able to reach the database — while every
 * in-process test stays green and the image builds clean. The whole round trip
 * runs through it: the CLI mints a campaign into a CSV, and every URL in that
 * CSV resolves against the lookup endpoint of the process next to it.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  demoRouterConfig,
  freePort,
  ROUTER_API_DIR,
  type RouterProcess,
  startRouterProcess,
} from '@confidential-router/demo';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CAMPAIGN = 'process-level-2026-10';
const GRANT_MICROS = '100000000';
const LANDING = 'https://router.superprotocol.example';

let router: RouterProcess;
/** Owned here rather than by the harness, so the CLI can open the same database. */
let workdir: string;
let databaseFile: string;

beforeAll(async () => {
  workdir = mkdtempSync(join(tmpdir(), 'cr-invites-e2e-'));
  databaseFile = join(workdir, 'router.sqlite');
  const port = await freePort();
  router = await startRouterProcess({
    port,
    env: {
      CR_API_SERVER__PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      CR_API_AUTH__BASE_URL: `http://127.0.0.1:${port}`,
      CR_API_DATABASE__FILE: databaseFile,
      CR_API_INVITES__LANDING_BASE_URL: LANDING,
    },
    config: demoRouterConfig({
      litellmUrl: 'http://127.0.0.1:1',
      evidenceUrl: 'https://127.0.0.1:1/.well-known/swarm-evidence',
      hostname: 'invites.e2e.invalid',
    }),
  });
});

afterAll(async () => {
  await router?.stop();
  rmSync(workdir, { recursive: true, force: true });
});

/** `node dist/cli/invites.js …`, on the database the running process is using. */
function invites(...args: string[]) {
  return spawnSync(process.execPath, [join(ROUTER_API_DIR, 'dist', 'cli', 'invites.js'), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      // An absolute path that does not exist: never pick up the repository's dev
      // config, or the one webpack copied next to the bundle.
      CR_API_CONFIG_FILE: join(workdir, 'absent.yaml'),
      CR_API_DATABASE__TYPE: 'sqlite',
      CR_API_DATABASE__FILE: databaseFile,
      CR_API_AUTH__SECRET: 'demo-secret-'.padEnd(48, 'x'),
      CR_API_INVITES__LANDING_BASE_URL: LANDING,
    },
  });
}

function lookup(code: string) {
  return fetch(`${router.baseUrl}/v1/invites/${encodeURIComponent(code)}`);
}

describe('the invites CLI, as built', () => {
  it('mints a campaign whose every URL resolves against the running lookup endpoint', async () => {
    const csvPath = join(workdir, 'codes.csv');

    const generated = invites(
      'generate',
      '--count',
      '5',
      '--grant',
      '100',
      '--campaign',
      CAMPAIGN,
      '--expires',
      '2027-12-31',
      '--out',
      csvPath,
    );
    expect(generated.stderr, generated.stderr).not.toContain('Failed');
    expect(generated.status).toBe(0);

    const rows = readFileSync(csvPath, 'utf8').trimEnd().split('\r\n');
    expect(rows[0]).toBe('code,url');
    expect(rows).toHaveLength(6);

    for (const row of rows.slice(1)) {
      const [code, url] = row.split(',');
      // The URL the mailing sends carries the code the CSV's first column has.
      expect(new URL(url).searchParams.get('invite')).toBe(code);
      expect(new URL(url).origin).toBe(LANDING);
      expect(new URL(url).searchParams.get('utm_campaign')).toBe(CAMPAIGN);

      const response = await lookup(code);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ valid: true, grantMicros: GRANT_MICROS, campaign: CAMPAIGN });
    }
  });

  it('reads the campaign back, seeing the codes it just wrote', () => {
    const stats = invites('stats', '--campaign', CAMPAIGN);

    expect(stats.status).toBe(0);
    expect(stats.stdout).toContain(`${CAMPAIGN}: issued 5, redeemed 0 (0.0%)`);
  });

  it('refuses to overwrite the CSV it already wrote — those codes are the only copy', () => {
    const again = invites(
      'generate',
      '--count',
      '1',
      '--grant',
      '5',
      '--campaign',
      'other',
      '--out',
      join(workdir, 'codes.csv'),
    );

    expect(again.status).toBe(2);
    expect(`${again.stderr}${again.stdout}`).toContain('already exists');
  });

  it('answers the same for a code that never existed as for one that cannot be used', async () => {
    const response = await lookup('ZZZZ-ZZZZ-ZZZZ');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ valid: false, reason: 'unavailable' });
  });
});
