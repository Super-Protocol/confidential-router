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
 * verdict, and the gatekeeper's Go tests drive `trust: cloud-measurement` with a
 * stubbed hardware report. What none of them can show is that the *seam* holds —
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
  type ExternalStand,
  externalEndpointEvents,
  ROTATED_MEASUREMENT,
  registerExternalEndpoint,
  removeTrustedMeasurement,
  STAND_MEASUREMENT,
  startExternalStand,
  waitForExternalStatus,
} from '@confidential-router/demo';
import OpenAI from 'openai';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** The upstream's own key — the registration token of decision 3. */
const UPSTREAM_API_KEY = 'sk-upstream-partner-cloud-0123456789';
const ENDPOINT_NAME = 'partner-cloud';
/** What this router publishes the model as, and what the upstream calls it. */
const EXTERNAL_MODEL = 'partner/llama-3.3-70b-instruct:snp';
const UPSTREAM_MODEL = 'vllm/llama-3.3-70b-instruct';

const VERIFIED = 'VERIFIED_BY_THIS_ROUTER';
const DENIED = 'DENIED_BY_THIS_ROUTER';

/**
 * Another cloud the operator trusts, and never the stand's.
 *
 * It is on the list for the whole suite, and it has to be: a
 * `trust: cloud-measurement` endpoint with an empty `trustedMeasurements` is an
 * *incomplete* gatekeeper configuration, which `gatekeeper run` refuses — so a
 * stand whose only listed cloud is the one it keeps withdrawing would spend half
 * its beats waiting for a configuration to start on rather than exercising a
 * denial. An operator curating external capacity has several clouds listed and
 * withdraws one, which is this.
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
let trustedId: string;
let client: OpenAI;

beforeAll(async () => {
  stand = await startExternalStand({ chunkGapMs: CHUNK_GAP_MS });
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

  it('serves nothing until a verdict admits it, and the registry is not a verdict', async () => {
    // The registration and this entry together are what give the sidecar the
    // first configuration the gatekeeper will run at all — before them there is
    // nothing to supervise, which is the state every deployment ships in
    // (`pkg/sidecar`).
    await addTrustedMeasurement(stand.admin, OTHER_CLOUD_MEASUREMENT, 'another cloud, not this one');
    await stand.sidecar.waitUntilStarted();

    // The stand's upstream reports a registry-signed measurement, which is the
    // strongest anchor there is, and the admin has not listed *this* cloud.
    // Ruling 2 on SUP-221: the list is the sole authority, so this is a denial,
    // and the denial pre-empts the obvious misreading. (`lastReason` is
    // `varchar(255)` and the full sentence is longer, so the assertion is on the
    // half that reaches a screen.)
    const denied = await waitForExternalStatus(stand.admin, endpointId, [DENIED]);
    expect(denied.lastStage).toBe('policy');
    expect(denied.lastReason).toContain(`measurement ${STAND_MEASUREMENT} is not listed`);
    expect(denied.lastReason).toContain('the Super Protocol registry does sign it');

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

  it('admits it once the admin lists the cloud', async () => {
    const trusted = await addTrustedMeasurement(stand.admin, STAND_MEASUREMENT);
    trustedId = trusted.id;

    const verified = await waitForExternalStatus(stand.admin, endpointId, [VERIFIED]);

    expect(verified.measurementSeen).toBe(STAND_MEASUREMENT);
    expect(verified.measurementSource).toBe('REGISTRY');
    expect(await listedModels()).toContain(EXTERNAL_MODEL);

    const kinds = (await externalEndpointEvents(stand.admin, endpointId)).map((event) => event.kind);
    expect(kinds).toContain('REGISTERED');
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

describe('fail-closed', () => {
  it('drops the model and refuses new traffic when the trust list no longer admits the cloud', async () => {
    expect(await removeTrustedMeasurement(stand.admin, trustedId)).toBe(true);

    const denied = await waitForExternalStatus(stand.admin, endpointId, [DENIED]);
    expect(denied.lastStage).toBe('policy');
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
    const readmitted = await addTrustedMeasurement(stand.admin, STAND_MEASUREMENT);
    await waitForExternalStatus(stand.admin, endpointId, [VERIFIED]);

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
    await removeTrustedMeasurement(stand.admin, readmitted.id);

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
    const trusted = await addTrustedMeasurement(stand.admin, STAND_MEASUREMENT);
    await waitForExternalStatus(stand.admin, endpointId, [VERIFIED]);

    // No admin edit this time: the upstream cloud itself comes back on another
    // VM image, and only the gatekeeper's own re-attestation loop can notice.
    expect(stand.sidecar.rotateMeasurement()).toBe(ROTATED_MEASUREMENT);

    const denied = await waitForExternalStatus(stand.admin, endpointId, [DENIED]);
    expect(denied.lastReason).toContain(ROTATED_MEASUREMENT);
    expect(await listedModels()).not.toContain(EXTERNAL_MODEL);

    const kinds = (await externalEndpointEvents(stand.admin, endpointId)).map((event) => event.kind);
    expect(kinds).toContain('MEASUREMENT_CHANGED');

    // Back to the listed image, and the same endpoint is admitted again without
    // anybody re-registering it: a verdict is about the upstream as it is now.
    stand.sidecar.restore();
    const readmitted = await waitForExternalStatus(stand.admin, endpointId, [VERIFIED]);
    expect(readmitted.measurementSeen).toBe(STAND_MEASUREMENT);
    expect(await listedModels()).toContain(EXTERNAL_MODEL);
    await removeTrustedMeasurement(stand.admin, trusted.id);
  });

  it("denies at untrusted-root when the upstream's own hardware report stops verifying", async () => {
    // The leg below the measurement check: with no attested root there is no
    // measurement to compare, and the admin's list cannot rescue it. This is the
    // one stage the stand substitutes, so asserting that a denial here reaches
    // the console as `untrusted-root` is what keeps the substitution honest —
    // a stand that could only ever say "admitted" would prove nothing.
    const trusted = await addTrustedMeasurement(stand.admin, STAND_MEASUREMENT);
    await waitForExternalStatus(stand.admin, endpointId, [VERIFIED]);

    stand.sidecar.denyAttestation('the stand withdrew the hardware report');

    const denied = await waitForExternalStatus(stand.admin, endpointId, [DENIED]);
    expect(denied.lastStage).toBe('untrusted-root');
    expect(denied.lastReason).toContain('the stand withdrew the hardware report');
    expect(await listedModels()).not.toContain(EXTERNAL_MODEL);

    stand.sidecar.restore();
    await removeTrustedMeasurement(stand.admin, trusted.id);
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
