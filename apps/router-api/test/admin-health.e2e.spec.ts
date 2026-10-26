import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness, signUpWithCode } from './app-harness.js';
import { type ConsoleSession, graphql } from './console.js';

/**
 * The health document from outside the cluster (SUP-479).
 *
 * `/health` is the kubelet's, and the chart keeps it off the Ingress — so on a
 * published deployment the `mail` and `analytics` reports that `/health` was
 * built to carry (SUP-269, SUP-464) could not be read at all. `/admin/health`
 * serves the same document on a prefix the Ingress already routes, behind the
 * operator's session.
 *
 * What these cases are about is the guard and the document being the same one,
 * not the fields: `health.e2e.spec.ts` owns what the report says.
 */

const BOOTSTRAP_TOKEN = 'bootstrap-token-'.padEnd(40, 'x');
const OPERATOR = 'admin@confidential-router.local';
const MEMBER = 'member@confidential-router.local';
const ADMIN_HEALTH = '/admin/health';

const harnesses: Harness[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
});

async function deploy(): Promise<Harness> {
  const harness = await createHarness({
    env: {
      CR_API_AUTH__BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
      CR_API_AUTH__ADMIN_EMAILS: OPERATOR,
    },
  });
  harnesses.push(harness);
  return harness;
}

async function operatorOf(harness: Harness): Promise<ConsoleSession> {
  const claimed = await request(harness.app.getHttpServer())
    .post('/auth/bootstrap')
    .send({ token: BOOTSTRAP_TOKEN })
    .expect(200);
  return sessionOf(harness, claimed);
}

async function sessionOf(harness: Harness, response: request.Response): Promise<ConsoleSession> {
  const raw = response.headers['set-cookie'];
  const cookies = (Array.isArray(raw) ? raw : [raw].filter(Boolean)) as string[];
  const session = { harness, cookies, email: '', workspaceId: '' };
  const me = await graphql(session, '{ me { email workspaces { id } } }');
  return { ...session, email: me.data.me.email, workspaceId: me.data.me.workspaces[0].id };
}

function get(harness: Harness, session?: ConsoleSession) {
  const pending = request(harness.app.getHttpServer()).get(ADMIN_HEALTH);
  return session ? pending.set('Cookie', session.cookies) : pending;
}

describe('GET /admin/health', () => {
  it('serves the operator the same document /health serves the kubelet', async () => {
    const harness = await deploy();
    const operator = await operatorOf(harness);

    const probe = await request(harness.app.getHttpServer()).get('/health').expect(200);
    const admin = await get(harness, operator).expect(200);

    // Same fields, same values — the uptime is the only one that moves between
    // two calls a moment apart, and `version` is what makes "which build is
    // this" answerable from outside at all.
    expect(Object.keys(admin.body).sort()).toEqual(Object.keys(probe.body).sort());
    expect(admin.body).toMatchObject({
      status: probe.body.status,
      version: probe.body.version,
      database: probe.body.database,
      mail: probe.body.mail,
      analytics: probe.body.analytics,
    });
    expect(admin.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('reports whether analytics is configured — the signal SUP-464 added and nobody could read', async () => {
    const harness = await deploy();
    const operator = await operatorOf(harness);

    const response = await get(harness, operator).expect(200);

    // `disabled` because the harness has no `POSTHOG_PROJECT_KEY`, which is the
    // shape of the rebuild SUP-464 is about. The point of this case is that an
    // operator can now see it without an exec into the pod.
    expect(response.body.analytics).toEqual({ status: 'disabled', dropped: 0 });
  });

  it('refuses a caller with no session', async () => {
    const harness = await deploy();
    await operatorOf(harness);

    await get(harness).expect(401);
  });

  it('refuses a signed-in user who is not an operator', async () => {
    const harness = await deploy();
    await operatorOf(harness);
    const member = await sessionOf(
      harness,
      await signUpWithCode(harness, { email: MEMBER, name: 'Member' }).expect(200),
    );

    await get(harness, member).expect(403);
  });

  it('refuses everyone when the deployment has named no operators', async () => {
    const harness = await createHarness({ env: { CR_API_AUTH__BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN } });
    harnesses.push(harness);
    const claimant = await operatorOf(harness);

    // `auth.adminEmails` is empty, and `AdminGuard` refuses an empty list rather
    // than treating it as "everyone" — the same direction as the other two
    // `/admin` routes. A deployment that wants the report names its operators.
    await get(harness, claimant).expect(403);
  });

  it('answers 200 with status error when the database is down, where /health answers 503', async () => {
    const harness = await deploy();
    const operator = await operatorOf(harness);

    // Only the health check's own round-trip fails: the session behind the guard
    // is already resolved by the time this runs. A real deployment that cannot
    // reach PostgreSQL cannot authenticate either, which is why `/health` stays
    // the probe — but the status code here must not be mistaken for one.
    const dataSource = harness.app.get<DataSource>(getDataSourceToken());
    vi.spyOn(dataSource, 'query').mockRejectedValue(new Error('connection refused'));

    const admin = await get(harness, operator).expect(200);
    expect(admin.body).toMatchObject({ status: 'error', database: { status: 'down', error: 'connection refused' } });

    await request(harness.app.getHttpServer()).get('/health').expect(503);
  });
});
