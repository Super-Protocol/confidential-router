import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PREVIEW_DATA_COPY } from './chat/verification/tiers';
import { PreviewDataNotice } from './preview-data-notice';

/**
 * The placement rule, asserted where it can be read off one component —
 * `storage-note.spec.tsx` is the model, and for the same reason: the defect this
 * guards against is not a wrong sentence but a reviewed sentence in the wrong
 * place, or a notice that grew into a gate.
 */
describe('PreviewDataNotice', () => {
  it('renders the condition inline, affirmatively and alone', () => {
    render(<PreviewDataNotice />);

    expect(screen.getByText('Private Preview: use synthetic or non-personal data')).toBeInTheDocument();
    // Counsel's full wording is behind the ⓘ, not under the composer.
    expect(screen.queryByText(/do not submit personal data/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/does not replace the Terms/i)).not.toBeInTheDocument();
  });

  it('names itself as something to read, so the restriction is not merely hidden', () => {
    // An unlabelled ⓘ is how honest copy disappears: the trigger has to say that
    // there is an answer behind it, to a screen reader as much as to a sighted
    // reader (SUP-189).
    render(<PreviewDataNotice />);

    expect(screen.getByRole('button', { name: 'What the Private Preview asks you not to submit' })).toBeInTheDocument();
  });

  it('publishes counsel’s sentence verbatim in the popover', async () => {
    render(<PreviewDataNotice />);

    await userEvent.click(screen.getByRole('button', { name: /what the private preview asks/i }));

    expect(
      await screen.findByText(
        'Please do not submit personal data, including sensitive personal data, in prompts or other content. Use synthetic or non-personal data for testing.',
      ),
    ).toBeInTheDocument();
  });

  it('says the notice does not replace the Terms, and links the clause it comes from', async () => {
    // Counsel's own constraint on this text. A notice that read as the whole
    // obligation would be the one thing she asked it not to be.
    render(<PreviewDataNotice />);

    await userEvent.click(screen.getByRole('button', { name: /what the private preview asks/i }));

    expect(await screen.findByText(/It does not replace the Terms of Service you accepted\./)).toBeInTheDocument();

    const terms = screen.getByRole('link', { name: 'Acceptable use (Terms §6)' });
    expect(terms).toHaveAttribute('href', PREVIEW_DATA_COPY.termsUrl);
    expect(terms).toHaveAttribute('target', '_blank');
    expect(terms).toHaveAttribute('rel', 'noreferrer noopener');
  });

  it('is a notice and not a gate: nothing to tick, nothing to dismiss, nothing stored', async () => {
    /*
     * The three shapes this was explicitly not allowed to take (SUP-501): a
     * checkbox, a dismissal, and a flag in `localStorage` to remember one —
     * which would be new browser storage to disclose, the sibling problem of
     * SUP-492.
     */
    const written: string[] = [];
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function spy(key: string, value: string) {
      written.push(key);
      return setItem.call(this, key, value);
    };

    try {
      render(<PreviewDataNotice />);
      await userEvent.click(screen.getByRole('button', { name: /what the private preview asks/i }));

      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /dismiss|got it|accept|ok|close/i })).not.toBeInTheDocument();
      expect(written).toEqual([]);
    } finally {
      Storage.prototype.setItem = setItem;
    }
  });
});
