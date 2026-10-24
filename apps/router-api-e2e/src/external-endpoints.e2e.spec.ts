/**
 * An external model endpoint, attested by the router, across every real process
 * boundary there is (ADR-008).
 *
 *   openai / fetch ─▶ router-api (dist/main.js) ─▶ gatekeeper-sidecar + gatekeeper
 *                                                        ═ TLS, pinned leaf ═▶
 *                                            mock-evidence-host ─▶ mock-litellm
 *
 * Why this suite exists beside the unit ones. Every piece of this is already
 * covered in isolation: `sidecar-config.spec.ts` pins the rendered file against
 * a golden, `external-endpoint-status.service.spec.ts` projects a hand-written
 * verdict, and the gatekeeper's Go tests drive `trust: measurement-and-digest`
 * with a stubbed hardware report. What none of them can show is that the *seam* holds —
 * that the file router-api renders is a file the real binary accepts, that the
 * admin API's `removeTrustedMeasurement` reaches a running proxy and takes a
 * model off `/v1/models`, and that a connection the gatekeeper closes mid-stream
 * comes back to the client as policy rather than as weather. ADR-007 §7a's
 * precedent applies: the gate lives in a library, so `nx affected` would skip
 * this on exactly the changes most likely to break it, and CI runs it
 * unconditionally.
 *
 * The one substitution: the attested-root *hardware* leg, which is read from a
 * file by `apps/gatekeeper/cmd/gatekeeper-teststand` — a build-tagged binary,
 * never in a release — because a SEV-SNP report is signed by AMD and no mock can
 * mint one. The sidecar supervising it is the shipped entrypoint, and everything
 * else in the pipeline is the production code path.
 */
import {
  addTrustedMeasurement,
  discoverExternalModels,
  type ExternalStand,
  externalEndpointEvents,
  pinExternalEndpointDigest,
  type RegisteredExternalEndpoint,
  ROTATED_MEASUREMENT,
  registerExternalEndpoint,
  STAND_MEASUREMENT,
  startExternalStand,
  waitForExternal,
  waitForExternalStatus,
  withdrawTrustedMeasurement,
} from '@confidential-router/demo';
import OpenAI from 'openai';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/** The upstream's own key — the registration token of decision 3. */
const UPSTREAM_API_KEY = 'sk-upstream-partner-cloud-0123456789';
const ENDPOINT_NAME = 'partner-cloud';
/** What this router publishes the model as, and what the upstream calls it. */
const EXTERNAL_MODEL = 'partner/llama-3.3-70b-instruct:snp';
const UPSTREAM_MODEL = 'vllm/llama-3.3-70b-instruct';

const VERIFIED = 'VERIFIED_BY_THIS_ROUTER';
const DENIED = 'DENIED_BY_THIS_ROUTER';
const PENDING = 'PENDING';

/**
 * Another cloud the operator trusts, and never the stand's — an operator curating
 * external capacity has several clouds listed and withdraws one.
 *
 * Not needed to start the sidecar any more: a `trust: measurement-and-digest`
 * endpoint runs before either factor is approved (SUP-252), because the first
 * check is how the console learns what to approve.
 */
const OTHER_CLOUD_MEASUREMENT = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';

/**
 * Chunks every 400 ms, so a generation lives long enough for an admin to
 * withdraw a cloud while it is streaming. The reply is some fifty words, which
 * is twenty seconds of stream — the abort lands in the first few.
 */
const CHUNK_GAP_MS = 400;

let stand: ExternalStand;
let endpointId: string;
/** The deployment the admin approved in the registration beats. */
let approvedDigest: string;
let client: OpenAI;

beforeAll(async () => {
  stand = await startExternalStand({ chunkGapMs: CHUNK_GAP_MS, upstreamModels: [UPSTREAM_MODEL] });
  client = new OpenAI({
    apiKey: stand.stack.credential.secret,
    baseURL: `${stand.stack.router.baseUrl}/v1`,
    maxRetries: 0,
  });
});

afterAll(async () => {
  await stand?.stop();
});

/** `GET /v1/models`, as the key sees it. */
async function listedModels(): Promise<string[]> {
  const response = await request(stand.stack.router.baseUrl)
    .get('/v1/models')
    .set('authorization', `Bearer ${stand.stack.credential.secret}`)
    .expect(200);
  return (response.body.data as { id: string }[]).map((model) => model.id);
}

/** One chat completion over raw HTTP, so an error body can be read as it is sent. */
async function chat(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${stand.stack.router.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${stand.stack.credential.secret}`,
    },
    body: JSON.stringify({ model: EXTERNAL_MODEL, messages: [{ role: 'user', content: 'Ping' }], ...body }),
  });
}

async function generationsOf(modelId: string): Promise<{ id: string; status: string; errorCode: string | null }[]> {
  const { generations } = await stand.admin.graphql<{
    generations: { edges: { node: { id: string; modelId: string; status: string; errorCode: string | null } }[] };
  }>(
    `query Log($workspaceId: ID!) {
       generations(workspaceId: $workspaceId, first: 50) {
         edges { node { id modelId status errorCode streamed } }
       }
     }`,
    { workspaceId: stand.admin.workspaceId },
  );
  return generations.edges.map((edge) => edge.node).filter((node) => node.modelId === modelId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('registration', () => {
  it('registers an upstream through the real admin API, sealing its key', async () => {
    const registered = await registerExternalEndpoint(stand.admin, {
      name: ENDPOINT_NAME,
      baseUrl: stand.upstream.url,
      apiKey: UPSTREAM_API_KEY,
      models: [{ id: EXTERNAL_MODEL, name: 'Llama 3.3 70B (partner cloud)', upstreamModel: UPSTREAM_MODEL }],
    });
    endpointId = registered.id;

    expect(registered.status).toBe('PENDING');
    expect(registered.models.map((model) => model.id)).toEqual([EXTERNAL_MODEL]);
    // The prefix is display state; the key itself has no read path at all.
    expect(registered.apiKeyPrefix).toBe(UPSTREAM_API_KEY.slice(0, registered.apiKeyPrefix?.length ?? 0));
    expect(JSON.stringify(registered)).not.toContain(UPSTREAM_API_KEY);
  });

  it('checks it once with nothing approved, and reports both factors for the admin to approve', async () => {
    await addTrustedMeasurement(stand.admin, OTHER_CLOUD_MEASUREMENT, 'another cloud, not this one');
    await stand.sidecar.waitUntilStarted();

    // SUP-252's TOFU-with-approval loop, first beat: the sidecar verifies the
    // upstream with whatever is approved — nothing — and the dossier gets both
    // values it saw. Pending, not denied: it is waiting for the admin, not for a
    // better upstream.
    const seen = await waitForExternal(stand.admin, endpointId, {
      until: (endpoint) => endpoint.lastStage === 'digest-not-pinned' && endpoint.evidenceDigestSeen !== null,
      wanted: 'both factors seen, digest-not-pinned',
    });
    expect(seen.status).toBe(PENDING);
    expect(seen.measurementSeen).toBe(STAND_MEASUREMENT);
    expect(seen.measurementSource).toBe('REGISTRY');
    expect(seen.pinnedEvidenceDigest).toBeNull();
    expect(seen.lastReason).toContain('no evidenceDigest is pinned');

    // The evidence summary the admin approves the digest from is filed before
    // any approval — bound to the leaf the sidecar observed, not to an egress pin.
    const summarised = await waitForExternal(stand.admin, endpointId, {
      until: (endpoint) => endpoint.latestEvidence?.evidenceDigest === endpoint.evidenceDigestSeen,
      wanted: 'the evidence summary for the digest seen',
    });
    expect(summarised.latestEvidence?.containerImages.length).toBeGreaterThan(0);

    expect(await listedModels()).not.toContain(EXTERNAL_MODEL);
    const refused = await chat({});
    const body = (await refused.json()) as { error: { type: string; code: string } };
    expect(refused.status).toBe(503);
    expect(body.error.type).toBe('gatekeeper_error');
    expect(body.error.code).toBe('attestation_failed');
    // Nothing reached the upstream: an unadmitted endpoint is refused before
    // the egress leg is asked for a connection.
    expect(stand.upstream.backend.requests).toHaveLength(0);
  });

  it('a trusted cloud alone admits nothing — the deployment is the second factor (T13)', async () => {
    await addTrustedMeasurement(stand.admin, STAND_MEASUREMENT);

    // The trust-list edit reloads the sidecar and forces a re-check at once;
    // several re-attestation intervals later the endpoint is still waiting for
    // its deployment to be approved. Under ADR-008's original ruling 1 this is
    // exactly where it would have been admitted.
    await sleep(3 * 2_000);
    const still = await waitForExternalStatus(stand.admin, endpointId, [PENDING]);
    expect(still.lastStage).toBe('digest-not-pinned');
    expect(await listedModels()).not.toContain(EXTERNAL_MODEL);
    expect((await chat({})).status).toBe(503);
  });

  it('admits it once the admin pins the digest it saw, and discovers its models through the egress', async () => {
    const seen = await waitForExternal(stand.admin, endpointId, {
      until: (endpoint) => endpoint.evidenceDigestSeen !== null,
      wanted: 'a digest seen',
    });
    approvedDigest = seen.evidenceDigestSeen ?? '';

    const pinned = await pinExternalEndpointDigest(stand.admin, endpointId, approvedDigest);
    expect(pinned.pinnedEvidenceDigest).toBe(approvedDigest);

    const verified = await waitForExternalStatus(stand.admin, endpointId, [VERIFIED]);
    expect(verified.measurementSeen).toBe(STAND_MEASUREMENT);
    expect(verified.evidenceDigestSeen).toBe(approvedDigest);
    expect(await listedModels()).toContain(EXTERNAL_MODEL);

    // Attest, then list (SUP-249): the first request upstream is the model list,
    // through the attested, certificate-pinned egress.
    const discovered = await discoverExternalModels(stand.admin, endpointId);
    expect(discovered).toEqual([{ upstreamModel: UPSTREAM_MODEL, registeredAs: EXTERNAL_MODEL }]);

    const kinds = (await externalEndpointEvents(stand.admin, endpointId)).map((event) => event.kind);
    expect(kinds).toContain('REGISTERED');
    expect(kinds).toContain('DIGEST_PINNED');
    expect(kinds).toContain(VERIFIED);
  });
});

describe('generation', () => {
  it('serves a non-streamed completion through the sidecar, with the injected key', async () => {
    const response = await chat({});
    const body = (await response.json()) as {
      choices: { message: { content: string } }[];
      usage: { endpoint?: string; prompt_tokens: number };
    };

    expect(response.status).toBe(200);
    expect(body.choices[0].message.content.length).toBeGreaterThan(0);
    expect(body.usage.endpoint).toBe(ENDPOINT_NAME);

    const forwarded = stand.upstream.backend.requests.at(-1);
    expect(forwarded?.path).toBe('/v1/chat/completions');
    // `model` rewritten to what the upstream knows it as, and the credential is
    // router-api's injection — the sidecar holds none of its own (ADR-003 §8).
    expect(forwarded?.body.model).toBe(UPSTREAM_MODEL);
    expect(forwarded?.authorization).toBe(`Bearer ${UPSTREAM_API_KEY}`);
    // No correlation header for another operator's logs (ADR-008 §4).
    expect(forwarded?.body).not.toHaveProperty('x-litellm-metadata');
  });

  it('streams one through the OpenAI SDK, and meters it as a completed generation', async () => {
    const stream = await client.chat.completions.create({
      model: EXTERNAL_MODEL,
      messages: [{ role: 'user', content: 'Stream from the external stand' }],
      stream: true,
    });

    let text = '';
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta?.content ?? '';
    }
    expect(text.length).toBeGreaterThan(0);

    // `ok`, and the SDK is the reason to say so out loud: it closes the response
    // the moment it has read `[DONE]`, and a relay that called that an abort
    // would meter every streamed generation from the official client as one —
    // which is also what would leave ruling 5's `aborted` meaning nothing.
    const metered = await waitForGenerations(2);
    expect(metered.filter((row) => row.status === 'OK')).toHaveLength(2);
  });
});

/**
 * Waits for a verdict the sidecar computed *after* this call, rather than for
 * whatever the row happens to hold.
 *
 * Every case below admits the stand's cloud, breaks one thing and asserts what
 * the next check made of it — and at the moment it breaks that thing, the row
 * still carries the previous check. A wait on the status alone accepts it: a
 * `VERIFIED_BY_THIS_ROUTER` the case before has already invalidated, or a
 * `DENIED_BY_THIS_ROUTER` that refused the *other* factor. The change then races
 * a verdict about someone else's, and the expectation fails on a real denial
 * with a real reason — which is how SUP-528's two red runs looked, both of them
 * green on a retry of the same commit.
 *
 * So: call this immediately after the change, and let `since` discard anything
 * older than it.
 */
function waitForNextVerdict(
  until: (endpoint: RegisteredExternalEndpoint) => boolean,
  wanted: string,
): Promise<RegisteredExternalEndpoint> {
  return waitForExternal(stand.admin, endpointId, { until, wanted, since: Date.now() });
}

/** The next check admits the endpoint. */
function waitUntilAdmitted(): Promise<RegisteredExternalEndpoint> {
  return waitForNextVerdict((endpoint) => endpoint.status === VERIFIED, 'the next check to admit it');
}

/**
 * The next check denies it *at this stage* — which is the claim each case below
 * is really making, so it belongs in the wait rather than in an expectation
 * after it. `[DENIED]` resolves on any denial, and these cases differ only in
 * which one they expect.
 */
function waitUntilDeniedAt(stage: string): Promise<RegisteredExternalEndpoint> {
  return waitForNextVerdict(
    (endpoint) => endpoint.status === DENIED && endpoint.lastStage === stage,
    `the next check to deny it at ${stage}`,
  );
}

/** Puts the stand's cloud back on the trust list, and waits for a check that admits it. */
async function trustStandCloud(): Promise<void> {
  await addTrustedMeasurement(stand.admin, STAND_MEASUREMENT);
  await waitUntilAdmitted();
}

describe('fail-closed', () => {
  /**
   * Undoing the break belongs in a hook, not in a case's last statements.
   *
   * Each of these used to end by restoring the sidecar and withdrawing the
   * measurement it had added — statements that run only when every expectation
   * before them passed. One flaky assertion therefore left `STAND_MEASUREMENT`
   * on the trust list, and the next case failed on its first line with "the
   * measurement … is already on the trust list": a cascade that reads as a
   * trust-list defect in router-api, is not one, and buried the failure that
   * actually happened (SUP-528).
   *
   * Both halves tolerate having nothing to do, so a case that reached its own
   * end is unaffected.
   */
  afterEach(async () => {
    stand.sidecar.restore();
    await withdrawTrustedMeasurement(stand.admin, STAND_MEASUREMENT);
  });

  it('drops the model and refuses new traffic when the trust list no longer admits the cloud', async () => {
    expect(await withdrawTrustedMeasurement(stand.admin, STAND_MEASUREMENT)).toBe(true);

    // The refused factor, not the generic `policy` stage: the console's fix for
    // it is "Add to trust list", and the stage is what tells it so.
    const denied = await waitUntilDeniedAt('measurement-not-trusted');
    // The denial names the measurement and the rule, which is what makes it
    // actionable rather than "the built-in pin policy denied".
    expect(denied.lastReason).toContain(STAND_MEASUREMENT);
    expect(denied.lastReason).toContain('attestedRoots.trustedMeasurements');

    expect(await listedModels()).not.toContain(EXTERNAL_MODEL);
    await request(stand.stack.router.baseUrl)
      .get(`/v1/models/${encodeURIComponent(EXTERNAL_MODEL)}`)
      .set('authorization', `Bearer ${stand.stack.credential.secret}`)
      .expect(404);

    const refused = await chat({});
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('attestation_failed');

    const kinds = (await externalEndpointEvents(stand.admin, endpointId)).map((event) => event.kind);
    expect(kinds).toContain(DENIED);
  });

  it('aborts an in-flight generation with attestation_revoked when the verdict flips under it', async () => {
    await trustStandCloud();

    const response = await chat({ stream: true });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('the router answered a streamed request with no body');
    }

    // Read the first chunks, so the generation is genuinely in flight, then pull
    // the cloud out from under it.
    const decoder = new TextDecoder();
    let raw = '';
    while (!raw.includes('"content"')) {
      const { value, done } = await reader.read();
      if (done) {
        throw new Error(`the stream ended before any content arrived:\n${raw}`);
      }
      raw += decoder.decode(value, { stream: true });
    }
    await withdrawTrustedMeasurement(stand.admin, STAND_MEASUREMENT);

    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      raw += decoder.decode(value, { stream: true });
    }

    // Ruling 5: the terminal frame names the reason class, so a client sees
    // policy and does not retry.
    expect(raw).toContain('attestation_revoked');
    expect(raw).toContain('[DONE]');
    const terminal = raw
      .split('\n\n')
      .map((frame) => frame.replace(/^data: /, '').trim())
      .filter((frame) => frame.includes('attestation_revoked'))
      .map((frame) => JSON.parse(frame) as { error: { type: string; code: string; message: string } })[0];
    expect(terminal.error.type).toBe('gatekeeper_error');
    expect(terminal.error.message).toContain('withdrawn');

    // And it is metered as an abort, not as an error: the generation was
    // admitted and running, and a decision about the upstream ended it.
    await waitFor(
      async () => (await generationsOf(EXTERNAL_MODEL)).some((row) => row.status === 'ABORTED'),
      20_000,
      'no generation was metered as aborted',
    );
    const aborted = (await generationsOf(EXTERNAL_MODEL)).filter((row) => row.status === 'ABORTED');
    expect(aborted[0].errorCode).toBe('attestation_revoked');
  });

  it('denies when the trusted cloud redeploys on an image nobody listed', async () => {
    await trustStandCloud();

    // No admin edit this time: the upstream cloud itself comes back on another
    // VM image, and only the gatekeeper's own re-attestation loop can notice.
    expect(stand.sidecar.rotateMeasurement()).toBe(ROTATED_MEASUREMENT);

    const denied = await waitUntilDeniedAt('measurement-not-trusted');
    expect(denied.lastReason).toContain(ROTATED_MEASUREMENT);
    expect(await listedModels()).not.toContain(EXTERNAL_MODEL);

    const kinds = (await externalEndpointEvents(stand.admin, endpointId)).map((event) => event.kind);
    expect(kinds).toContain('MEASUREMENT_CHANGED');

    // Back to the listed image, and the same endpoint is admitted again without
    // anybody re-registering it: a verdict is about the upstream as it is now.
    stand.sidecar.restore();
    const readmitted = await waitUntilAdmitted();
    expect(readmitted.measurementSeen).toBe(STAND_MEASUREMENT);
    expect(await listedModels()).toContain(EXTERNAL_MODEL);
  });

  /**
   * The beat two-factor trust exists for (SUP-252, closing T13): the cloud is
   * unchanged and still trusted, the upstream redeploys, and the new deployment
   * is not the one an admin approved. It fails closed — `digest-mismatch`, models
   * dropped — and the dossier has both digests and both evidence summaries for
   * the "approve new digest" decision.
   */
  it('fails closed with digest-mismatch when the upstream redeploys, until the new digest is approved', async () => {
    await trustStandCloud();

    // No admin edit: the upstream redeploys, and only the sidecar's own
    // re-attestation loop can notice.
    const redeployed = await stand.upstream.evidenceHost.rotateDeployment('sup-252-redeploy');

    const denied = await waitUntilDeniedAt('digest-mismatch');
    expect(denied.pinnedEvidenceDigest).toBe(approvedDigest);
    expect(denied.evidenceDigestSeen).not.toBe(approvedDigest);
    expect(denied.measurementSeen).toBe(STAND_MEASUREMENT);
    expect(await listedModels()).not.toContain(EXTERNAL_MODEL);
    const refused = await chat({});
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('attestation_failed');

    const kinds = (await externalEndpointEvents(stand.admin, endpointId)).map((event) => event.kind);
    expect(kinds).toContain('DIGEST_CHANGED');

    // Old vs new, from what this router filed: the approved deployment's summary
    // and the redeployed one's, which is what the dossier diffs.
    const dossier = await waitForExternal(stand.admin, endpointId, {
      until: (endpoint) =>
        endpoint.latestEvidence?.evidenceDigest === endpoint.evidenceDigestSeen && endpoint.pinnedEvidence !== null,
      wanted: 'both evidence summaries filed',
    });
    expect(dossier.pinnedEvidence?.evidenceDigest).toBe(approvedDigest);
    expect(dossier.latestEvidence?.evidenceDigest).toBe(dossier.evidenceDigestSeen);

    // Approve new digest — one click, the same mutation — and it is admitted
    // again without anybody re-registering it.
    expect(dossier.evidenceDigestSeen).toBe(redeployed);
    await pinExternalEndpointDigest(stand.admin, endpointId, redeployed);
    const readmitted = await waitUntilAdmitted();
    expect(readmitted.pinnedEvidenceDigest).toBe(redeployed);
    expect(readmitted.evidenceDigestSeen).toBe(redeployed);
    expect(await listedModels()).toContain(EXTERNAL_MODEL);
    approvedDigest = readmitted.pinnedEvidenceDigest ?? '';
  });

  it("denies at untrusted-root when the upstream's own hardware report stops verifying", async () => {
    // The leg below the measurement check: with no attested root there is no
    // measurement to compare, and the admin's list cannot rescue it. This is the
    // one stage the stand substitutes, so asserting that a denial here reaches
    // the console as `untrusted-root` is what keeps the substitution honest —
    // a stand that could only ever say "admitted" would prove nothing.
    await trustStandCloud();

    stand.sidecar.denyAttestation('the stand withdrew the hardware report');

    const denied = await waitUntilDeniedAt('untrusted-root');
    expect(denied.lastReason).toContain('the stand withdrew the hardware report');
    expect(await listedModels()).not.toContain(EXTERNAL_MODEL);
  });
});

/** Generations for the external model, once there are at least `atLeast` of them. */
async function waitForGenerations(
  atLeast: number,
): Promise<{ id: string; status: string; errorCode: string | null }[]> {
  await waitFor(
    async () => (await generationsOf(EXTERNAL_MODEL)).length >= atLeast,
    20_000,
    `fewer than ${atLeast} generation(s) were metered for ${EXTERNAL_MODEL}`,
  );
  return generationsOf(EXTERNAL_MODEL);
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`${message} (waited ${timeoutMs}ms)`);
    }
    await sleep(200);
  }
}
