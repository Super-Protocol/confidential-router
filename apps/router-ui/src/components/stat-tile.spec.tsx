import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatTile } from './stat-tile';

describe('StatTile', () => {
  it('names itself so four tiles on a screen stay tellable apart', () => {
    render(<StatTile label="Spend" value="$149.34" />);

    expect(within(screen.getByRole('group', { name: 'Spend' })).getByText('$149.34')).toBeInTheDocument();
  });

  it('exposes the series as a labelled chart', () => {
    render(
      <StatTile
        label="Requests"
        value="10.9K"
        series={[
          { label: 'Aug 30', value: 0 },
          { label: 'Aug 31', value: 12 },
        ]}
      />,
    );

    expect(screen.getByRole('img', { name: 'Requests per day' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: 'Aug 31' })).toBeInTheDocument();
  });

  it('draws a meter for a ratio', () => {
    const { container } = render(<StatTile label="Evidence coverage" value="100%" meter={1} tone="success" />);

    expect(container.querySelector('[data-slot="stat-tile"] .bg-success')).toHaveStyle({ width: '100%' });
  });

  it('clamps a ratio that arrives out of range', () => {
    const { container } = render(<StatTile label="Evidence coverage" value="120%" meter={1.2} />);

    expect(container.querySelector('[data-slot="stat-tile"] .bg-brand')).toHaveStyle({ width: '100%' });
  });
});
