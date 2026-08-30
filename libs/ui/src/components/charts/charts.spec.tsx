import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BarChart } from './bar-chart';
import { Heatmap } from './heatmap';
import { Sparkline } from './sparkline';

describe('BarChart', () => {
  const data = [
    { label: 'Mon', value: 10 },
    { label: 'Tue', value: 20 },
    { label: 'Wed', value: 0 },
  ];

  it('exposes the series to assistive technology as an image plus a table', () => {
    render(<BarChart data={data} label="Requests per day" />);

    expect(screen.getByRole('img', { name: 'Requests per day' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Requests per day' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: 'Tue' })).toBeInTheDocument();
  });

  it('scales bars against the largest bucket', () => {
    const { container } = render(<BarChart data={data} label="Requests per day" />);
    const bars = container.querySelectorAll('[data-slot="bar-chart"] > div');

    expect(bars[0]).toHaveStyle({ height: '50%' });
    expect(bars[1]).toHaveStyle({ height: '100%' });
  });

  it('draws a zero bucket as a flat tick rather than nothing', () => {
    const { container } = render(<BarChart data={data} label="Requests per day" />);
    const bars = container.querySelectorAll('[data-slot="bar-chart"] > div');

    expect(bars[2]).toHaveStyle({ height: '2px' });
  });

  it('survives an all-zero series without dividing by zero', () => {
    const { container } = render(<BarChart data={[{ label: 'Mon', value: 0 }]} label="Requests per day" />);
    const bar = container.querySelector('[data-slot="bar-chart"] > div');

    expect(bar).toHaveStyle({ height: '2px' });
  });

  it('formats values in the fallback table', () => {
    render(<BarChart data={data} label="Spend" format={(value) => `$${value.toFixed(2)}`} />);

    expect(screen.getByText('$20.00')).toBeInTheDocument();
  });
});

describe('Sparkline', () => {
  function pointsOf(container: HTMLElement): number[][] {
    const raw = container.querySelector('polyline')?.getAttribute('points') ?? '';
    return raw
      .split(' ')
      .filter(Boolean)
      .map((pair) => pair.split(',').map(Number));
  }

  it('spreads points across the full width', () => {
    const { container } = render(<Sparkline values={[0, 5, 10]} label="Trend" width={100} height={20} />);
    const points = pointsOf(container);

    expect(points).toHaveLength(3);
    expect(points[0][0]).toBe(0);
    expect(points[2][0]).toBe(100);
  });

  it('draws a flat series mid-height instead of collapsing it onto the baseline', () => {
    const { container } = render(<Sparkline values={[5, 5, 5]} label="Flat" height={20} strokeWidth={2} />);
    const ys = pointsOf(container).map(([, y]) => y);

    // inset 2 + 0.5 * (20 - 4) = 10
    expect(new Set(ys)).toEqual(new Set([10]));
  });

  it('renders nothing but its label for an empty series', () => {
    const { container } = render(<Sparkline values={[]} label="No data" />);

    expect(container.querySelector('polyline')).toBeNull();
    expect(screen.getByRole('img', { name: 'No data' })).toBeInTheDocument();
  });
});

describe('Heatmap', () => {
  const cells = [
    { date: '2026-03-01', value: 0 },
    { date: '2026-03-02', value: 1 },
    { date: '2026-03-03', value: 10 },
  ];

  it('gives every non-zero day a warmer step than an empty one', () => {
    const { container } = render(<Heatmap cells={cells} label="Signed responses" rows={3} />);
    const tiles = container.querySelectorAll('[data-slot="heatmap"] > div');

    expect(tiles[0].className).toContain('bg-muted');
    expect(tiles[1].className).toContain('bg-brand/25');
    expect(tiles[2].className).toContain('bg-brand');
  });

  it('derives the column count from the data', () => {
    const { container } = render(<Heatmap cells={cells} label="Signed responses" rows={2} />);
    const grid = container.querySelector('[data-slot="heatmap"]') as HTMLElement;

    expect(grid.style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))');
  });

  it('honours an explicit max so several heatmaps can share a scale', () => {
    const { container } = render(<Heatmap cells={cells} label="Signed responses" max={100} rows={3} />);
    const tiles = container.querySelectorAll('[data-slot="heatmap"] > div');

    expect(tiles[2].className).toContain('bg-brand/25');
  });
});
