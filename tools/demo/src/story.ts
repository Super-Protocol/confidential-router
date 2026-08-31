/**
 * The demo, as a sequence of checked steps.
 *
 * It tells one story end to end and asserts every claim it makes on the way:
 *
 *   1. a user signs in, tops up and mints a key — through the console's own API
 *   2. a gatekeeper is configured from scratch with the commands `init` prints
 *   3. it verifies the router's published evidence and pins what it found
 *   4. an OpenAI SDK call reaches a model through it, and the router meters it
 *   5. the deployment is rotated — the very next call is refused, fail-closed,
 *      with the stage and reason that refused it
 *   6. the new digest is pinned and traffic resumes
 *
 * Step 5 is the one worth having. Everything before it is a happy path that a
 * dozen unit tests already cover; a proxy that *stops* when the thing it
 * verified changes underneath it is the property the whole product rests on,
 * and nothing short of a live rotation demonstrates it.
 */
import OpenAI from 'openai';
import { VERDICT_HEADER } from './constants.js';
import { createGatekeeper, type Gatekeeper, type RunningGatekeeper } from './gatekeeper.js';
import { delay } from './router-process.js';
import { DEMO_MODEL, freePort, type RouterStack, startRouterStack } from './stack.js';

/** How long a verdict flip may take to be noticed before we call it a failure. */
const VERDICT_FLIP_TIMEOUT_MS = 30_000;

/** How long the metering write may lag the response it describes. */
const METERING_TIMEOUT_MS = 10_000;

/** Short enough that a rotation is noticed while someone is still watching. */
const DEMO_REATTEST_INTERVAL = '2s';
const DEMO_VERDICT_CACHE_TTL = '1s';

export interface StoryOptions {
  /** Called before each step, so a runner can narrate. */
  onStep?: (title: string) => void;
  /** Called with anything worth showing under the current step. */
  onDetail?: (detail: string) => void;
  /** Mirror the router's and the gatekeeper's logs to stderr. */
  verbose?: boolean;
}

export interface StoryResult {
  /** The digest pinned first, and the one the rotation produced. */
  firstDigest: string;
  rotatedDigest: string;
  /** The denial the rotation caused, as the client saw it. */
  denial: { status: number; stage: string; reason: string; verdictHeader: string };
  /** Generations the router metered, and what they cost. */
  metered: { count: number; costMicros: number };
  /** Wall-clock milliseconds, so the 10-minute budget is observable. */
  durationMs: number;
}

interface Denial {
  error: { message: string; type: string; code: string };
  stage: string;
  reason: string;
}

/** Runs the whole story, or throws at the first step that does not hold. */
export async function runStory(options: StoryOptions = {}): Promise<StoryResult> {
  const startedAt = Date.now();
  const step = (title: string): void => options.onStep?.(title);
  const detail = (text: string): void => options.onDetail?.(text);

  let stack: RouterStack | undefined;
  let gatekeeper: Gatekeeper | undefined;
  let running: RunningGatekeeper | undefined;

  try {
    step('Start the router, the model backend and the evidence publisher');
    stack = await startRouterStack({ echoRouterLog: options.verbose });
    detail(`router-api      ${stack.router.baseUrl}`);
    detail(`mock-litellm    ${stack.backend.url}`);
    detail(`evidence host   ${stack.upstreamUrl} (fronting the router over TLS)`);
    detail(`workspace       ${stack.session.workspaceId}, balance ${usd(stack.balanceMicros)}`);
    detail(`api key         ${stack.credential.secret.slice(0, 12)}… (shown once, by the console)`);

    step('Configure a gatekeeper from nothing');
    gatekeeper = createGatekeeper();
    const listenPort = await freePort();
    const listen = `127.0.0.1:${listenPort}`;
    detail(await firstLine(gatekeeper.mustRun('init')));
    detail(
      await firstLine(
        gatekeeper.mustRun('trust', 'roots', 'add', 'swarm-cloud-demo', '--pem-file', stack.trustedRootFile),
      ),
    );
    detail(
      await firstLine(
        gatekeeper.mustRun('endpoint', 'add', 'router', '--listen', listen, '--upstream', stack.upstreamUrl),
      ),
    );

    step('Verify what the endpoint publishes, and pin it');
    const pinned = await gatekeeper.mustRun('endpoint', 'trust', 'add', 'router', '--from-upstream', '--yes');
    detail(pinned.stdout.trim());
    const firstDigest = stack.evidenceHost.evidenceDigest();
    expect(pinned.stdout.includes(firstDigest), `the pinned digest should be the published one (${firstDigest})`);
    detail(await firstLine(gatekeeper.mustRun('config', 'validate')));

    step('Run the gatekeeper');
    running = await gatekeeper.start(
      listen,
      '--reattest-interval',
      DEMO_REATTEST_INTERVAL,
      '--verdict-cache-ttl',
      DEMO_VERDICT_CACHE_TTL,
    );
    const baseURL = `http://${listen}/v1`;
    detail(`listening on ${baseURL}`);

    step('Call a model with the OpenAI SDK, through the gatekeeper');
    const client = new OpenAI({ apiKey: stack.credential.secret, baseURL, maxRetries: 0 });
    // The first verdict is formed after the listener binds, so the first call
    // can legitimately arrive during the fail-closed window.
    let answer: string | null = null;
    await waitFor(
      async () => {
        answer = await chat(client);
        return answer !== null;
      },
      VERDICT_FLIP_TIMEOUT_MS,
      'the gatekeeper never admitted the first request',
    );
    detail(`model    ${DEMO_MODEL}`);
    detail(`answer   ${(answer ?? '').slice(0, 96)}…`);

    step('The router metered it');
    // Metering is written after the response is flushed, so the client can see
    // its answer before the row exists. Polling is the honest wait here.
    const metered = await waitForMetering(stack, 1);
    detail(`${metered.count} generation(s), ${usd(metered.costMicros)} charged to the workspace`);

    step('Redeploy the endpoint — the pinned digest is no longer what it publishes');
    const rotatedDigest = await stack.evidenceHost.rotateDeployment('sup-84-demo');
    expect(rotatedDigest !== firstDigest, 'the rotation should have produced a different digest');
    detail(`was  ${firstDigest}`);
    detail(`now  ${rotatedDigest}`);

    step('The next call is refused — fail-closed, with the stage that refused it');
    const denial = await waitForDenial(baseURL, stack.credential.secret, VERDICT_FLIP_TIMEOUT_MS);
    expect(denial.status === 503, `a refused request should be 503, got ${denial.status}`);
    expect(denial.stage === 'policy', `the denial should come from the policy stage, got "${denial.stage}"`);
    expect(denial.reason.length > 0, 'a denial should say why');
    detail(`HTTP ${denial.status} — ${denial.stage}: ${denial.reason}`);
    detail(`${VERDICT_HEADER}: ${denial.verdictHeader}`);

    step('Pin the new digest, reload, and traffic resumes');
    detail(await firstLine(gatekeeper.mustRun('endpoint', 'trust', 'add', 'router', rotatedDigest)));
    running.reload();
    await waitFor(
      async () => (await chat(client)) !== null,
      VERDICT_FLIP_TIMEOUT_MS,
      'the gatekeeper did not admit traffic again after the new digest was pinned',
    );
    detail('admitted again');

    const after = await waitForMetering(stack, metered.count + 1);

    return {
      firstDigest,
      rotatedDigest,
      denial,
      metered: after,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await running?.stop();
    gatekeeper?.cleanup();
    await stack?.stop();
  }
}

/** One chat completion, or `null` when the gatekeeper refused it. */
async function chat(client: OpenAI): Promise<string | null> {
  try {
    const completion = await client.chat.completions.create({
      model: DEMO_MODEL,
      messages: [{ role: 'user', content: 'Is this endpoint attested?' }],
    });
    return completion.choices[0]?.message?.content ?? '';
  } catch (error) {
    if (isRefusal(error)) {
      return null;
    }
    throw error;
  }
}

function isRefusal(error: unknown): boolean {
  const status = (error as { status?: number }).status;
  return status === 503;
}

/**
 * Polls until the gatekeeper refuses a call, and reports how it refused.
 *
 * Plain `fetch`, not the SDK: `stage` and `reason` sit beside `error` at the top
 * level of the denial body (they are the gatekeeper's fields, not OpenAI's), and
 * an SDK that only surfaces `body.error` would throw them away. Reading the body
 * as it is on the wire is also what pins the contract `docs/gatekeeper.md`
 * documents.
 */
async function waitForDenial(baseURL: string, apiKey: string, timeoutMs: number): Promise<StoryResult['denial']> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: DEMO_MODEL,
        messages: [{ role: 'user', content: 'Is this endpoint still the one I pinned?' }],
      }),
    });
    if (response.status === 503) {
      const body = (await response.json()) as Denial;
      return {
        status: response.status,
        stage: body.stage ?? '',
        reason: body.reason ?? '',
        verdictHeader: response.headers.get(VERDICT_HEADER) ?? '',
      };
    }
    await response.body?.cancel();
    if (Date.now() > deadline) {
      throw new Error(`the gatekeeper kept admitting traffic ${timeoutMs}ms after the deployment changed`);
    }
    await delay(250);
  }
}

async function meteredGenerations(stack: RouterStack): Promise<{ count: number; costMicros: number }> {
  const data = await stack.session.graphql<{
    generations: { edges: { node: { costMicros: string; status: string; evidenceDigest: string | null } }[] };
  }>(
    'query Metered($workspaceId: ID!) { generations(workspaceId: $workspaceId, first: 50) ' +
      '{ edges { node { costMicros status evidenceDigest } } } }',
    { workspaceId: stack.session.workspaceId },
  );
  // `GenerationStatus` is a GraphQL enum, so it comes back upper-cased.
  const ok = data.generations.edges.map((edge) => edge.node).filter((node) => node.status === 'OK');
  return { count: ok.length, costMicros: ok.reduce((total, node) => total + Number(node.costMicros), 0) };
}

/** Polls until the router has metered at least `atLeast` successful generations. */
async function waitForMetering(stack: RouterStack, atLeast: number): Promise<{ count: number; costMicros: number }> {
  let latest = { count: 0, costMicros: 0 };
  await waitFor(
    async () => {
      latest = await meteredGenerations(stack);
      return latest.count >= atLeast;
    },
    METERING_TIMEOUT_MS,
    `the router recorded ${latest.count} generation(s), expected at least ${atLeast}`,
  );
  return latest;
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
    await delay(250);
  }
}

async function firstLine(result: Promise<{ stdout: string; stderr: string }>): Promise<string> {
  const { stdout, stderr } = await result;
  return (stdout.trim() || stderr.trim()).split('\n')[0];
}

function expect(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function usd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(4)}`;
}
