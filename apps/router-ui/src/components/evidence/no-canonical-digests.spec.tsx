import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { evidenceSnapshot, publishedEndpoint, verifiedUpstream } from '../../test-fixtures';
import { renderWithApollo } from '../../test-utils';
import { EVIDENCE, REDEPLOYED_ENDPOINT, VERIFIED_ENDPOINT } from '../admin/admin-mocks';
import { EndpointTimeline } from '../admin/endpoint-timeline';
import { EvidenceSummary } from '../admin/evidence-summary';
import { ExternalAttestationBadge } from '../external/external-attestation-badge';
import { EvidenceModal } from './evidence-modal';

/**
 * No user-facing surface spells a digest in the canonical wire form.
 *
 * SUP-115 made hex the one human-facing spelling of every digest, measurement
 * and fingerprint — it is what the gatekeeper prints, what its config records
 * and what the browser extension shows, so a value read anywhere in the console
 * can be pasted into `gatekeeper endpoint trust add` and compared by eye. The
 * `sha256/<base64url>` form stays on the wire: it is part of the signed bundle
 * and the API keeps sending it beside the hex twin. The upstream dialog on the
 * Models page regressed to the wire form in 0.15.0 (SUP-255), which is what this
 * file pins against, surface by surface: every fixture below carries a canonical
 * value in every canonical field, and nothing a reader can see or hover may
 * match the shape.
 */

/** The wire form: `sha256/` followed by base64url. Hex has a colon, never a slash. */
const CANONICAL = /sha256\/[A-Za-z0-9_-]+/;

function visibleText(): string {
  const titles = [...document.querySelectorAll('[title]')].map((node) => node.getAttribute('title') ?? '');
  return [document.body.textContent ?? '', ...titles].join('\n');
}

describe('no surface shows a canonical sha256/<base64url> digest', () => {
  it('the upstream dialog behind “Verified by this router” (the 0.15.0 regression)', async () => {
    const upstream = verifiedUpstream();
    expect(upstream.evidenceDigestSeen).toMatch(CANONICAL);
    render(<ExternalAttestationBadge upstream={upstream} />);

    await userEvent.click(screen.getByRole('button', { name: /^Attestation of/ }));
    await screen.findByRole('dialog');

    expect(visibleText()).toContain(`sha256:${upstream.evidenceDigestSeenHex?.slice(0, 8)}`);
    expect(visibleText()).not.toMatch(CANONICAL);
  });

  it('the evidence summary of an external endpoint', () => {
    expect(EVIDENCE.evidenceDigest).toMatch(CANONICAL);
    expect(EVIDENCE.certFingerprint).toMatch(CANONICAL);
    render(<EvidenceSummary evidence={EVIDENCE} />);

    expect(visibleText()).not.toMatch(CANONICAL);
  });

  it('the verdict timeline, digest-changed entries included', () => {
    const events = [...VERIFIED_ENDPOINT.events, ...REDEPLOYED_ENDPOINT.events];
    expect(events.some((event) => CANONICAL.test(event.evidenceDigest ?? ''))).toBe(true);
    render(<EndpointTimeline events={events} />);

    expect(visibleText()).not.toMatch(CANONICAL);
  });

  it('the evidence modal of one of this router’s own endpoints', () => {
    const endpoint = publishedEndpoint({ latestEvidence: evidenceSnapshot() });
    expect(endpoint.latestEvidence?.evidenceDigest).toMatch(CANONICAL);
    renderWithApollo(<EvidenceModal endpoint={endpoint} open onOpenChange={vi.fn()} />, { mocks: [] });

    expect(visibleText()).not.toMatch(CANONICAL);
  });
});
