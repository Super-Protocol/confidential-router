import { expect, request, test } from '@playwright/test';
import { readHandoff, type StackHandoff, useSession } from './stack';

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
 */

let handoff: StackHandoff;

test.beforeAll(() => {
  handoff = readHandoff();
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
