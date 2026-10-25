import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { evidenceSnapshot, publishedEndpoint } from '../../test-fixtures';
import { renderWithApollo, renderWithSession, sessionMock } from '../../test-utils';
import { DEPLOYMENT_DIGEST_QUERY, DeploymentDigest } from './deployment-digest';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));

/** The pinned digest of the walk that found this gap (SUP-541), in the gatekeeper's spelling. */
const HEX = '3509d9f922d02ed3ec3faf50bbb26399661e93f8e44dbda83a4f84b3d0100f16';

function digestMock(routerEndpoint: unknown) {
  return {
    request: { query: DEPLOYMENT_DIGEST_QUERY },
    result: { data: { routerEndpoint } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  };
}

function ownEndpoint(overrides: Record<string, unknown> = {}) {
  return {
    ...publishedEndpoint({
      hostname: 'api.router.superprotocol.com',
      latestEvidence: evidenceSnapshot({ evidenceDigestHex: HEX, tee: 'Intel TDX (Azure)' }),
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
    renderWithApollo(<DeploymentDigest />, { mocks: [digestMock(ownEndpoint())] });

    const value = await screen.findByTestId('deployment-digest-value');
    // The whole point: the gatekeeper prints `sha256:<64 hex>` and asks y/n, so
    // the console has to offer the same string to compare it against.
    expect(value.textContent).toBe(`sha256:${HEX}`);
    expect(value.textContent).not.toContain('…');
  });

  it('names the endpoint and the TEE its evidence claims, and shows the publication state', async () => {
    renderWithApollo(<DeploymentDigest />, { mocks: [digestMock(ownEndpoint())] });

    await screen.findByTestId('deployment-digest-value');
    expect(screen.getByTestId('deployment-digest').textContent).toContain('api.router.superprotocol.com');
    expect(screen.getByTestId('deployment-digest').textContent).toContain('Intel TDX (Azure)');
    expect(screen.getByText('Published')).toBeTruthy();
  });

  it('copies the full value, so a reader can diff rather than read', async () => {
    renderWithApollo(<DeploymentDigest />, { mocks: [digestMock(ownEndpoint())] });

    await screen.findByTestId('deployment-digest-value');
    await userEvent.click(screen.getByRole('button', { name: /^Copy the evidence digest of/ }));

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`sha256:${HEX}`));
  });

  it('says there is nothing to compare against when the platform publishes no bundle', async () => {
    renderWithApollo(<DeploymentDigest />, {
      mocks: [digestMock(ownEndpoint({ evidenceState: 'NOT_PUBLISHED', latestEvidence: null }))],
    });

    await screen.findByTestId('deployment-digest');
    expect(screen.queryByTestId('deployment-digest-value')).toBeNull();
    expect(screen.getByTestId('deployment-digest').textContent).toContain('pin nothing');
  });

  it('renders nothing when the router cannot name its own endpoint', async () => {
    const { container } = renderWithApollo(<DeploymentDigest />, { mocks: [digestMock(null)] });

    await waitFor(() => expect(container.querySelector('[data-testid="deployment-digest"]')).toBeNull());
    await waitFor(() => expect(container.querySelector('[aria-hidden="true"]')).toBeNull());
  });

  it('never spells the digest in the canonical wire form (SUP-115)', async () => {
    renderWithApollo(<DeploymentDigest />, { mocks: [digestMock(ownEndpoint())] });

    await screen.findByTestId('deployment-digest-value');
    expect(document.body.textContent ?? '').not.toMatch(/sha256\/[A-Za-z0-9_-]+/);
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
    renderWithApollo(<HowToConnect />, { mocks: [digestMock(ownEndpoint())] });

    expect((await screen.findByTestId('deployment-digest-value')).textContent).toBe(`sha256:${HEX}`);
  });

  it('is mounted by the Overview page', async () => {
    const { default: OverviewPage } = await import('../../app/(console)/page');
    // The page has no hooks of its own — everything with data in it is a client
    // child — so rendering the element it returns is the honest check that the
    // block is wired in, rather than a second assertion about the same import.
    renderWithSession(<>{OverviewPage()}</>, { mocks: [sessionMock(), digestMock(ownEndpoint())] });

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
