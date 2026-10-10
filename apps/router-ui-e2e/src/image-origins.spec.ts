import { expect, type Page, type Request, test } from '@playwright/test';
import { consoleUrl, DEPLOYMENTS, type ImageDeployment } from './image-origins';

/**
 * One published image, two API origins, no rebuild in between (SUP-100).
 *
 * `playwright.image.config.ts` runs the same image twice with different
 * `ROUTER_UI_API_ORIGIN`; what is asserted here is not that the document says
 * the right thing but that the *browser* sends its requests there — the failure
 * mode of build-time `NEXT_PUBLIC_*` was precisely a container whose server knew
 * the new origin and whose bundle did not.
 */

const SIGN_IN_OPTIONS = {
  data: {
    signInOptions: {
      bootstrap: false,
      adminRecovery: false,
      github: true,
      google: true,
      emailCode: true,
      emailCodeLength: 6,
      magicLink: true,
      inviteRequired: false,
    },
  },
};

/**
 * Answers the API on `apiOrigin` — nothing is listening there — and records
 * every request the page makes to anywhere.
 */
async function observe(page: Page, apiOrigin: string): Promise<string[]> {
  const requested: string[] = [];
  page.on('request', (request: Request) => requested.push(request.url()));

  await page.route(`${apiOrigin}/graphql`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SIGN_IN_OPTIONS) }),
  );
  await page.route(`${apiOrigin}/auth/**`, (route) =>
    route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'not configured' }),
    }),
  );

  return requested;
}

/** The `/_next/static/**` URLs a document loads — the bundle's identity. */
async function bundleOf(page: Page, deployment: ImageDeployment): Promise<string[]> {
  const response = await page.request.get(consoleUrl(deployment, '/login'));
  const html = await response.text();

  return [...html.matchAll(/\/_next\/static\/[^"']+/g)].map(([asset]) => asset).sort();
}

for (const [name, deployment] of Object.entries(DEPLOYMENTS)) {
  const other = Object.values(DEPLOYMENTS).find((candidate) => candidate !== deployment)!;

  test(`the ${name} container's browser talks to ${deployment.apiOrigin}`, async ({ page }) => {
    const requested = await observe(page, deployment.apiOrigin);

    await page.goto(consoleUrl(deployment, '/login'));
    // The sign-in screen's only query. Rendering the providers means it resolved,
    // which means it reached the origin this container was configured with.
    await expect(page.getByRole('button', { name: /continue with github/i })).toBeVisible();

    expect(requested).toContain(`${deployment.apiOrigin}/graphql`);
    expect(requested.filter((url) => url.startsWith(other.apiOrigin))).toEqual([]);
  });

  test(`the ${name} container signs in against ${deployment.apiOrigin}`, async ({ page }) => {
    const requested = await observe(page, deployment.apiOrigin);

    await page.goto(consoleUrl(deployment, '/login'));
    await page.getByRole('button', { name: /continue with github/i }).click();
    // The stub above refuses, which is what puts the error on screen — and what
    // proves the request went out rather than failing to be addressed at all.
    await expect(page.getByText(/not configured/i)).toBeVisible();

    expect(requested).toContain(`${deployment.apiOrigin}/auth/sign-in/social`);
  });
}

test('both containers serve the same bundle, so neither was rebuilt for its origin', async ({ page }) => {
  const [alpha, beta] = await Promise.all([bundleOf(page, DEPLOYMENTS.alpha), bundleOf(page, DEPLOYMENTS.beta)]);

  expect(alpha).not.toHaveLength(0);
  expect(alpha).toEqual(beta);
});

// SUP-263: `output: 'standalone'` leaves `public/` out of its tree, so the
// favicon only reaches a browser if the Dockerfile copies it. Asserted on the
// image, without a session — the proxy must let it through to the sign-in page.
test('the image serves the Super Protocol favicon, PNG and the .ico fallback', async ({ page }) => {
  const png = await page.request.get(consoleUrl(DEPLOYMENTS.alpha, '/favicon.png'));
  expect(png.status()).toBe(200);
  expect(png.headers()['content-type']).toContain('image/png');

  const ico = await page.request.get(consoleUrl(DEPLOYMENTS.alpha, '/favicon.ico'));
  expect(ico.status()).toBe(200);
  // ICONDIR: reserved 0, type 1 (icon).
  expect([...(await ico.body()).subarray(0, 4)]).toEqual([0, 0, 1, 0]);
});
