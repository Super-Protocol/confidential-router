import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { evidenceSnapshot, publishedEndpoint } from '../../test-fixtures';
import { renderWithApollo, renderWithSession, sessionMock } from '../../test-utils';
import { DEPLOYMENT_DIGEST_QUERY, DeploymentDigest } from './deployment-digest';
import { DEPLOYMENT_DIGEST_HEX, deploymentDigestMock } from './evidence-mocks';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));

const HEX = DEPLOYMENT_DIGEST_HEX;

function ownEndpoint(overrides: Record<string, unknown> = {}) {
  return {
    ...publishedEndpoint({
      hostname: 'api.router.superprotocol.com',
      latestEvidence: evidenceSnapshot({
        evidenceDigestHex: HEX,
        tee: 'Intel TDX (Azure)',
        issuedAt: '2026-10-25T17:32:32.096Z',
      }),
    }),
    ...overrides,
  };
}

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

describe('DeploymentDigest', () => {
  it('prints all 64 characters of the digest, not an elision of it', async () => {
    renderWithApollo(<DeploymentDigest />, { mocks: [deploymentDigestMock(ownEndpoint())] });

    const value = await screen.findByTestId('deployment-digest-value');
    // The whole point: the gatekeeper prints `sha256:<64 hex>` and asks y/n, so
    // the console has to offer the same string to compare it against.
    expect(value.textContent).toBe(`sha256:${HEX}`);
    expect(value.textContent).not.toContain('…');
  });

  it('names the endpoint, the TEE its evidence claims, when it was issued, and the publication state', async () => {
    renderWithApollo(<DeploymentDigest />, { mocks: [deploymentDigestMock(ownEndpoint())] });

    await screen.findByTestId('deployment-digest-value');
    const block = screen.getByTestId('deployment-digest');
    expect(block.textContent).toContain('api.router.superprotocol.com');
    expect(block.textContent).toContain('Intel TDX (Azure)');
    // `issuedAt` is how a reader whose gatekeeper printed something else tells a
    // stale tab from a deployment that has just changed.
    expect(block.textContent).toContain('issued 2026-10-25 17:32 UTC');
    expect(screen.getByText('Published')).toBeTruthy();
  });

  it('copies the full value, so a reader can diff rather than read', async () => {
    renderWithApollo(<DeploymentDigest />, { mocks: [deploymentDigestMock(ownEndpoint())] });

    await screen.findByTestId('deployment-digest-value');
    await userEvent.click(screen.getByRole('button', { name: /^Copy the evidence digest of/ }));

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`sha256:${HEX}`));
  });

  it('says there is nothing to compare against when the platform publishes no bundle', async () => {
    renderWithApollo(<DeploymentDigest />, {
      mocks: [deploymentDigestMock(ownEndpoint({ evidenceState: 'NOT_PUBLISHED', latestEvidence: null }))],
    });

    await screen.findByTestId('deployment-digest');
    expect(screen.queryByTestId('deployment-digest-value')).toBeNull();
    expect(screen.getByTestId('deployment-digest').textContent).toContain('pin nothing');
  });

  /**
   * The branch that reproduces the bug. A failed query used to return `null`,
   * so the reader at the `--from-upstream` y/n got exactly what SUP-541
   * reports — nothing, with no reason given — and would have had no way to
   * tell "this deployment publishes no digest" from "the console could not
   * fetch one".
   */
  it('says the digest could not be loaded when the query fails, and offers a retry', async () => {
    renderWithApollo(<DeploymentDigest />, {
      mocks: [{ request: { query: DEPLOYMENT_DIGEST_QUERY }, error: new Error('network down') }],
    });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('could not be loaded');
    expect(alert.textContent).toContain('nothing to compare a gatekeeper’s report against');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByTestId('deployment-digest')).toBeNull();
  });

  it('retries the query from the error state', async () => {
    renderWithApollo(<DeploymentDigest />, {
      mocks: [
        { request: { query: DEPLOYMENT_DIGEST_QUERY }, error: new Error('network down'), maxUsageCount: 1 },
        deploymentDigestMock(ownEndpoint()),
      ],
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));

    expect((await screen.findByTestId('deployment-digest-value')).textContent).toBe(`sha256:${HEX}`);
  });

  /**
   * The one silence that is honest: with no endpoint of its own, no digest on
   * this page would be the one a `--from-upstream` report is about, so there is
   * no question to answer and nothing to say about it.
   */
  it('renders nothing when the router cannot name its own endpoint', async () => {
    const { container } = renderWithApollo(<DeploymentDigest />, { mocks: [deploymentDigestMock(null)] });

    await waitFor(() => expect(container.querySelector('[data-testid="deployment-digest"]')).toBeNull());
    await waitFor(() => expect(container.querySelector('[role="alert"]')).toBeNull());
    await waitFor(() => expect(container.querySelector('[aria-hidden="true"]')).toBeNull());
  });

  it('never spells the digest in the canonical wire form (SUP-115)', async () => {
    renderWithApollo(<DeploymentDigest />, { mocks: [deploymentDigestMock(ownEndpoint())] });

    await screen.findByTestId('deployment-digest-value');
    expect(document.body.textContent ?? '').not.toMatch(/sha256\/[A-Za-z0-9_-]+/);
  });

  /**
   * The level is the host page's outline, not decoration: a fixed `h3` made the
   * block read as a fourth numbered step inside "How to connect", which is how
   * `api-keys-screen.spec` found it.
   */
  it('puts its heading at the level the host page asks for', async () => {
    renderWithApollo(<DeploymentDigest title="On Overview" headingLevel="h2" />, {
      mocks: [deploymentDigestMock(ownEndpoint())],
    });

    expect(await screen.findByRole('heading', { level: 2, name: 'On Overview' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull();
  });

  it('labels its heading per instance, so two mounted blocks do not share one id', async () => {
    renderWithApollo(
      <>
        <DeploymentDigest title="First" />
        <DeploymentDigest title="Second" />
      </>,
      { mocks: [deploymentDigestMock(ownEndpoint())] },
    );

    const [first, second] = await screen.findAllByTestId('deployment-digest');
    const labelOf = (node: HTMLElement) => node.getAttribute('aria-labelledby');
    expect(labelOf(first)).toBeTruthy();
    expect(labelOf(first)).not.toBe(labelOf(second));
    // And each one points at its own heading, not at the other's.
    expect(document.getElementById(labelOf(first) as string)?.textContent).toBe('First');
    expect(document.getElementById(labelOf(second) as string)?.textContent).toBe('Second');
  });
});

/**
 * The block has to be reachable from both places a reader can be standing when
 * the pin decision arrives: the screen the docs name (Overview) and the screen
 * that prints the command (`/keys#how-to-connect`). Rendering it in one and not
 * the other is how the gap re-opens.
 */
describe('where the digest is reachable', () => {
  it('is mounted by the API Keys “How to connect” block', async () => {
    const { HowToConnect } = await import('../keys/how-to-connect');
    renderWithApollo(<HowToConnect />, { mocks: [deploymentDigestMock(ownEndpoint())] });

    expect((await screen.findByTestId('deployment-digest-value')).textContent).toBe(`sha256:${HEX}`);
  });

  it('is mounted by the Overview page', async () => {
    const { default: OverviewPage } = await import('../../app/(console)/page');
    // The page has no hooks of its own — everything with data in it is a client
    // child — so rendering the element it returns is the honest check that the
    // block is wired in, rather than a second assertion about the same import.
    renderWithSession(<>{OverviewPage()}</>, { mocks: [sessionMock(), deploymentDigestMock(ownEndpoint())] });

    expect((await screen.findByTestId('deployment-digest-value')).textContent).toBe(`sha256:${HEX}`);
  });
});

/**
 * Every other digest surface stays truncated for layout, but the whole value
 * has to exist somewhere a screen reader reaches — the tooltip and the
 * clipboard are not that place.
 */
describe('DigestValue', () => {
  it('exposes the untruncated digest to assistive technology', async () => {
    const { DigestValue } = await import('./digest-value');
    render(<DigestValue hex={HEX} canonical={`sha256/${'A'.repeat(43)}`} />);

    expect(screen.getByText(`sha256:${HEX}`)).toBeTruthy();
  });
});
