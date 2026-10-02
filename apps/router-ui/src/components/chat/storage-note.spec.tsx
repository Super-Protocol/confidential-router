import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { StorageNote } from './storage-note';
import { HISTORY_COPY } from './verification/tiers';

/**
 * The placement rule, asserted where it can be read off one component.
 *
 * `tiers.spec.ts` holds the words; this holds *which surface shows which*. The
 * defect Denis reported was not a wrong sentence, it was a true sentence in the
 * wrong place — so the test that would have caught it is this one.
 */
describe('StorageNote', () => {
  it('renders the summary inline and nothing else until it is asked', () => {
    render(<StorageNote copy={HISTORY_COPY.attested_server} />);

    expect(screen.getByText('Stored inside the attested boundary')).toBeInTheDocument();
    expect(screen.queryByText(/may be lost/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/encrypted at rest/i)).not.toBeInTheDocument();
  });

  it('names itself as something to read, so the caveat is not merely hidden', () => {
    // An unlabelled ⓘ is how honest copy disappears: the trigger has to say that
    // there is an answer behind it, to a screen reader as much as to a sighted
    // reader.
    render(<StorageNote copy={HISTORY_COPY.attested_server} />);

    expect(screen.getByRole('button', { name: 'What this means for your conversations' })).toBeInTheDocument();
  });

  it('publishes the caveat in the popover, in the privacy policy’s sentence', async () => {
    render(<StorageNote copy={HISTORY_COPY.attested_server} />);

    await userEvent.click(screen.getByRole('button', { name: /what this means/i }));

    expect(
      await screen.findByText('Your conversations may be lost during infrastructure maintenance.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/encrypted at rest/i)).toBeInTheDocument();
  });

  it('calls out to the delete control instead of describing it', async () => {
    const onRevealDelete = vi.fn();
    render(<StorageNote copy={HISTORY_COPY.attested_server} onRevealDelete={onRevealDelete} />);

    await userEvent.click(screen.getByRole('button', { name: /what this means/i }));
    await userEvent.click(await screen.findByRole('button', { name: 'Show the delete control' }));

    expect(onRevealDelete).toHaveBeenCalledOnce();
  });

  it('drops the delete link when the screen has no conversation to delete', async () => {
    render(<StorageNote copy={HISTORY_COPY.attested_server} />);

    await userEvent.click(screen.getByRole('button', { name: /what this means/i }));

    expect(await screen.findByText(/deleted outright/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete control/i })).not.toBeInTheDocument();
  });

  it('shows no maintenance paragraph for storage that has no maintenance caveat', async () => {
    // Browser-local history cannot be taken by a cluster's maintenance, and a
    // caveat that is always on is one nobody reads.
    render(<StorageNote copy={HISTORY_COPY.browser_local} />);

    await userEvent.click(screen.getByRole('button', { name: /what this means/i }));

    expect(await screen.findByText(/local storage/i)).toBeInTheDocument();
    expect(screen.queryByText(/infrastructure maintenance/i)).not.toBeInTheDocument();
  });
});
