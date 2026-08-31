import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Label } from './label';
import { Switch } from './switch';

describe('Switch', () => {
  it('is a labelled switch, not a checkbox or a styled div', () => {
    render(
      <>
        <Label htmlFor="archive">Archive quotes</Label>
        <Switch id="archive" defaultChecked />
      </>,
    );

    const control = screen.getByRole('switch', { name: 'Archive quotes' });
    expect(control).toBeChecked();
  });

  it('reports each flip once, with the new state', async () => {
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Archive quotes" onCheckedChange={onCheckedChange} />);

    await userEvent.click(screen.getByRole('switch', { name: 'Archive quotes' }));

    expect(onCheckedChange).toHaveBeenCalledTimes(1);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('cannot be flipped while disabled', async () => {
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Archive quotes" disabled onCheckedChange={onCheckedChange} />);

    await userEvent.click(screen.getByRole('switch', { name: 'Archive quotes' }));

    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});
