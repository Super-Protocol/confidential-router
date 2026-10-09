import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { InfoPopover } from './info-popover';

/**
 * The placement rule, asserted on the one component that carries it (SUP-262):
 * the explanation is not on screen until asked for, the trigger says what it
 * holds, and one press publishes the words unchanged.
 */
describe('InfoPopover', () => {
  it('names itself as something to read, and shows nothing until pressed', () => {
    render(
      <InfoPopover label="Why this is here">
        <p>The rest of the sentence.</p>
      </InfoPopover>,
    );

    expect(screen.getByRole('button', { name: 'Why this is here' })).toBeInTheDocument();
    expect(screen.queryByText('The rest of the sentence.')).not.toBeInTheDocument();
  });

  it('publishes the explanation on one press', async () => {
    render(
      <InfoPopover label="Why this is here">
        <p>The rest of the sentence.</p>
      </InfoPopover>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Why this is here' }));

    expect(await screen.findByText('The rest of the sentence.')).toBeInTheDocument();
  });
});
