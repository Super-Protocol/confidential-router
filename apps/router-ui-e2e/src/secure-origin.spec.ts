import { expect, type Page, request, test } from '@playwright/test';
import { type ExternalHandoff, readHandoff, requireExternal, type StackHandoff, useSession } from './stack';

/**
 * Tier 1, actually running — the one thing the rest of this suite cannot show.
 *
 * `playwright.secure.config.ts` explains why it needs its own origins. The short
 * version: the console's evidence gate is Web Crypto from end to end, browsers
 * withhold Web Crypto from a named http origin, and the main suite serves one on
 * purpose. So everything past "this page cannot look" — a real bundle fetched, a
 * real chain validated, a real JWS verified, and a graph drawn out of the payload
 * that verified — is proven here or nowhere.
 *
 * Nothing is mocked. The bundle comes from `tools/mock-evidence-host`, signed a
 * second earlier by a real key over a real PKI; the digests on screen are the
 * digests that host published; and the redeployment in the middle is an actual
 * re-signed snapshot, not a doctored fixture.
 *
 * The second half of the file is the same claim about a document this page could
 * not have fetched at all: an **external upstream's** evidence, relayed by the
 * router and verified here (ADR-008 §7). That is the per-user mitigation for the
 * one thing pinning this router cannot cover — the trust list is database state,
 * not part of the canonical snapshot (ADR-008 §1) — so a browser that can check
 * the other end itself is the whole point, and this is the only suite with a
 * browser that can.
 */

let handoff: StackHandoff;
/** The upstream `CR_DEMO_EXTERNAL=1` registered, verified and made relayable. */
let external: ExternalHandoff;

test.beforeAll(async () => {
  handoff = await readHandoff();
  external = requireExternal(handoff);
});

test.beforeEach(async ({ page, baseURL }) => {
  await useSession(page, baseURL as string, handoff);
});

test('verifies the published bundle in the browser and unlocks the composer', async ({ page }) => {
  await page.goto('/chat');

  // The badge the gate reaches only when every blocking check passed: the bundle
  // was retrieved, the chain validated, the JWS verified against the chain leaf,
  // the freshness window honoured, and the published TLS leaf hashed to the
  // fingerprint the payload signs.
  await expect(page.getByText('Verified by this page')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel('Message')).toBeEnabled();
});

test('draws the deployment graph from the document it just verified', async ({ page }) => {
  await page.goto('/chat');
  await expect(page.getByText('Verified by this page')).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Inspect attestation' }).click();
  const dialog = page.getByRole('dialog', { name: /Attestation for this endpoint/i });

  // The digest on screen is the one the stack handed over, which is the one the
  // host signed — so the panel is reading the real document and not a fixture.
  const expectedHex = Buffer.from(handoff.evidenceDigest.replace(/^sha256\//, ''), 'base64url').toString('hex');
  await expect(dialog.getByText(`sha256:${expectedHex}`)).toBeVisible();

  await dialog.getByRole('tab', { name: 'Deployment graph' }).click();
  await expect(dialog.getByRole('button', { name: /^Workload router-api/ })).toBeVisible();

  // Both images the host signed are ones the stand's config declares, so both
  // come back green. This is the verdict path a doctored fixture can only
  // simulate: two independent sources that happen to agree.
  for (const name of ['router-api', 'litellm']) {
    await expect(
      dialog.getByRole('button', { name: new RegExp(`^Container ${name}.*digest declared by the operator`, 's') }),
    ).toBeVisible();
  }

  await dialog.getByRole('button', { name: /^Workload router-api/ }).click();
  await expect(page.getByRole('dialog', { name: 'router-api' }).getByText(/"kind": "Deployment"/)).toBeVisible();
});

test('turns red when a redeployment runs images the operator never declared', async ({ page }) => {
  /*
   * The case the comparison exists for, driven by a real event: the host
   * republishes the same workloads at fresh digests and re-signs, while the
   * stand's `declaredImages` still names the old ones.
   *
   * The distinction the panel has to keep is the point of the assertions below.
   * The new bundle's signature is perfectly sound, so the badge still reads
   * "Verified by this page" — what changed is not whether the document is
   * authentic but whether anybody said the deployment should look like this.
   */
  await page.goto('/chat');
  await expect(page.getByText('Verified by this page')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Inspect attestation' }).click();
  const dialog = page.getByRole('dialog', { name: /Attestation for this endpoint/i });
  await dialog.getByRole('tab', { name: 'Deployment graph' }).click();
  await expect(dialog.getByRole('button', { name: /^Workload router-api/ })).toBeVisible();

  const control = await request.newContext({ ignoreHTTPSErrors: true });
  try {
    const rotated = await control.post(`${handoff.evidenceHostUrl}/__mock/rotate-deployment`);
    expect(rotated.ok()).toBe(true);
    expect(((await rotated.json()) as { evidenceDigest: string }).evidenceDigest).not.toBe(handoff.evidenceDigest);
  } finally {
    await control.dispose();
  }

  // The browser reads the bundle through the router's passthrough — the host's
  // own URL carries a port its hostname does not — so the evidence poll has to
  // come round before a recheck can see the new publication.
  await expect(async () => {
    await dialog.getByRole('button', { name: /Check again/ }).click();
    await expect(dialog.getByText(/images the operator did not declare/)).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });

  await expect(dialog.getByText('Verified by this page')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Container router-api.*different digest/s })).toBeVisible();
  // And the tab the reader was on survived the recheck.
  await expect(dialog.getByRole('tab', { name: 'Deployment graph', selected: true })).toBeVisible();
});

/** `sha256/<base64url>` as the panel spells it: `sha256:<hex>`. */
function shownDigest(published: string): string {
  return `sha256:${Buffer.from(published.replace(/^sha256\//, ''), 'base64url').toString('hex')}`;
}

/**
 * Switches the thread to the external model and opens the upstream's panel.
 *
 * Two buttons sit on this screen once an external model is selected, and which
 * one is pressed is the whole distinction ADR-008 §1 draws: "Inspect
 * attestation" is about the router your browser is connected to, "Inspect
 * upstream attestation" is about a deployment in someone else's cluster.
 */
async function openUpstreamPanel(page: Page, upstream: ExternalHandoff) {
  await page.goto('/chat');
  // The built-in model's gate first, so the screen is settled before the
  // selection — and so a failure here is read as the stack, not the upstream.
  await expect(page.getByText('Verified by this page')).toBeVisible({ timeout: 30_000 });

  await selectModel(page, upstream.modelName);

  await page.getByRole('button', { name: 'Inspect upstream attestation' }).click();
  return page.getByRole('dialog', { name: /Attestation for this external upstream/i });
}

/** Switches the thread's model by the name the picker renders. */
async function selectModel(page: Page, name: string): Promise<void> {
  await page.getByRole('combobox', { name: 'Model' }).click();
  await page.getByRole('option', { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click();
}

test('verifies a relayed external bundle in the browser, and names where it came from', async ({ page }) => {
  const dialog = await openUpstreamPanel(page, external);

  // Tier 1 over the upstream's document, run by this page: the relay fetched,
  // the chain validated, the JWS verified against the chain leaf. The badge is
  // the same one the own-endpoint panel reaches, because it is the same verifier
  // over the same checks — which is what "rendered the same way" was asked for.
  await expect(dialog.getByText('Verified by this page')).toBeVisible({ timeout: 30_000 });

  // The row that must be read before any other: this is not a document the page
  // fetched from the host, and it is not fresher than the verdict that named it.
  //
  // Both mock hosts answer on `localhost` — a different name would mean a real
  // DNS lookup in CI for a cosmetic difference — so it is the *relay* wording
  // that carries the claim here, and the digest in the last case of this file
  // that proves which host was read.
  await expect(dialog.getByText(new RegExp(`this router.s relay of ${external.hostname}`))).toBeVisible();
  await expect(dialog.getByText(/relayed unchanged/)).toBeVisible();

  // The digest on screen is the one `ExternalEndpoint.evidenceDigestSeen` holds
  // — the publication this router's own verdict admitted, which is the only
  // thing the relay will answer with (ADR-008 §7).
  await expect(dialog.getByText(shownDigest(external.evidenceDigest))).toBeVisible();

  // And the sentence the tier caveat cannot carry, because it is about topology
  // rather than tiers: the prompt does not travel over this channel.
  await expect(dialog.getByText(/Your connection terminates at this router/)).toBeVisible();
});

test('draws the upstream’s deployment graph, with nothing to compare it against', async ({ page }) => {
  const dialog = await openUpstreamPanel(page, external);
  await expect(dialog.getByText('Verified by this page')).toBeVisible({ timeout: 30_000 });

  await dialog.getByRole('tab', { name: 'Deployment graph' }).click();
  await expect(dialog.getByRole('button', { name: /^Workload router-api/ })).toBeVisible();

  /*
   * Every container comes back "nothing was compared", and that is the correct
   * answer rather than a gap: nobody declared what another deployment runs, and
   * v1 does not ask an operator to (ADR-008 §7). A green "declared by the
   * operator" here would mean the screen had compared the upstream's images
   * against *this* deployment's allow-list — the one mistake this panel must
   * never make.
   */
  for (const name of ['router-api', 'litellm']) {
    await expect(
      dialog.getByRole('button', { name: new RegExp(`^Container ${name}.*nothing was compared`, 's') }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: new RegExp(`^Container ${name}.*declared by the operator`, 's') }),
    ).toHaveCount(0);
  }

  // The graph is drawn out of the payload that verified, so its raw fields are
  // the upstream's own resources.
  await dialog.getByRole('button', { name: /^Workload router-api/ }).click();
  await expect(page.getByRole('dialog', { name: 'router-api' }).getByText(/"kind": "Deployment"/)).toBeVisible();
});

test('keeps the two endpoints apart: each panel shows the document of its own host', async ({ page }) => {
  /*
   * The property ADR-008 §1 rests on, asserted where it can actually be wrong.
   * Both panels are the same component over the same verifier, and the two hosts
   * publish genuinely different snapshots (`serve.ts` redeploys the external one
   * before anything verifies it), so a panel reading the wrong document shows
   * the wrong digest rather than looking identical.
   *
   * This router's own digest is read off the host *now* rather than from the
   * handoff: an earlier case in this file redeploys it on purpose, and the claim
   * here is about which host each panel reads, not about what either published
   * when the stack came up.
   */
  const ownDigest = await publishedDigest(handoff.evidenceHostUrl);
  expect(external.evidenceDigest).not.toBe(ownDigest);

  await page.goto('/chat');
  await expect(page.getByText('Verified by this page')).toBeVisible({ timeout: 30_000 });
  await selectModel(page, external.modelName);

  // This router's own panel, about the host the browser is connected to.
  await page.getByRole('button', { name: 'Inspect attestation' }).click();
  const own = page.getByRole('dialog', { name: /Attestation for this endpoint/i });
  await expect(own.getByText(shownDigest(ownDigest))).toBeVisible({ timeout: 30_000 });
  await expect(own.getByText(shownDigest(external.evidenceDigest))).toHaveCount(0);
  await expect(own.getByText(/the endpoint itself|this router.s passthrough/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(own).toBeHidden();

  // And the upstream's, about a deployment in someone else's cluster.
  await page.getByRole('button', { name: 'Inspect upstream attestation' }).click();
  const upstream = page.getByRole('dialog', { name: /Attestation for this external upstream/i });
  await expect(upstream.getByText(shownDigest(external.evidenceDigest))).toBeVisible({ timeout: 30_000 });
  await expect(upstream.getByText(shownDigest(ownDigest))).toHaveCount(0);
});

/** What a mock evidence host is publishing right now, over its control API. */
async function publishedDigest(evidenceHostUrl: string): Promise<string> {
  const control = await request.newContext({ ignoreHTTPSErrors: true });
  try {
    const state = await control.get(`${evidenceHostUrl}/__mock/state`);
    expect(state.ok()).toBe(true);
    return ((await state.json()) as { evidenceDigest: string }).evidenceDigest;
  } finally {
    await control.dispose();
  }
}
