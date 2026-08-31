import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StackedBarChart, tickIndices } from './stacked-bar-chart';

const series = [
  { key: 'input', label: 'Input tokens' },
  { key: 'output', label: 'Output tokens' },
];

const data = [
  { label: 'Mon', values: { input: 30, output: 10 } },
  { label: 'Tue', values: { input: 60, output: 20 } },
  { label: 'Wed', values: { input: 0, output: 0 } },
];

function segmentsOf(container: HTMLElement): HTMLElement[][] {
  return Array.from(container.querySelectorAll('[data-slot="stacked-bar"]')).map((bar) =>
    Array.from(bar.children).map((child) => child as HTMLElement),
  );
}

describe('StackedBarChart', () => {
  it('exposes the series to assistive technology as an image plus a table', () => {
    render(<StackedBarChart data={data} series={series} label="Usage by model" />);

    expect(screen.getByRole('img', { name: 'Usage by model' })).toBeInTheDocument();

    const table = screen.getByRole('table', { name: 'Usage by model' });
    expect(within(table).getByRole('columnheader', { name: 'Output tokens' })).toBeInTheDocument();
    expect(within(table).getByRole('rowheader', { name: 'Tue' })).toBeInTheDocument();
  });

  it('scales every column against the tallest total, not against each series', () => {
    const { container } = render(<StackedBarChart data={data} series={series} label="Usage" />);
    const [monday, tuesday] = segmentsOf(container);

    // Tallest total is Tuesday's 80.
    expect(monday[0]).toHaveStyle({ height: '37.5%' });
    expect(monday[1]).toHaveStyle({ height: '12.5%' });
    expect(tuesday[0]).toHaveStyle({ height: '75%' });
    expect(tuesday[1]).toHaveStyle({ height: '25%' });
  });

  it('draws an all-zero bucket as a flat tick rather than dropping it off the axis', () => {
    const { container } = render(<StackedBarChart data={data} series={series} label="Usage" />);
    const [, , wednesday] = segmentsOf(container);

    expect(wednesday).toHaveLength(1);
    expect(wednesday[0]).toHaveStyle({ height: '2px' });
  });

  it('omits a zero series from a non-empty column', () => {
    const { container } = render(
      <StackedBarChart data={[{ label: 'Mon', values: { input: 10, output: 0 } }]} series={series} label="Usage" />,
    );

    expect(segmentsOf(container)[0]).toHaveLength(1);
  });

  it('survives an all-zero series without dividing by zero', () => {
    const { container } = render(
      <StackedBarChart data={[{ label: 'Mon', values: { input: 0, output: 0 } }]} series={series} label="Usage" />,
    );

    expect(segmentsOf(container)[0][0]).toHaveStyle({ height: '2px' });
  });

  it('keeps two buckets that share a label apart when they carry distinct ids', () => {
    // A rolling 24-hour window opens and closes on the same hour.
    const { container } = render(
      <StackedBarChart
        data={[
          { id: '2026-08-30T14:00:00.000Z', label: '14:00', values: { input: 10, output: 0 } },
          { id: '2026-08-31T14:00:00.000Z', label: '14:00', values: { input: 20, output: 0 } },
        ]}
        series={series}
        label="Usage"
      />,
    );

    expect(segmentsOf(container)).toHaveLength(2);
    expect(screen.getAllByRole('rowheader', { name: '14:00' })).toHaveLength(2);
  });

  it('formats values in the fallback table and totals the stack', () => {
    render(
      <StackedBarChart data={data} series={series} label="Usage" format={(value) => `${value} tok`} legend={false} />,
    );

    const row = screen.getByRole('row', { name: /Tue/ });
    expect(within(row).getByText('60 tok')).toBeInTheDocument();
    expect(within(row).getByText('80 tok')).toBeInTheDocument();
  });

  it('lists the series in a legend, and can be asked not to', () => {
    const { rerender } = render(<StackedBarChart data={data} series={series} label="Usage" />);

    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Input tokens', 'Output tokens']);

    rerender(<StackedBarChart data={data} series={series} label="Usage" legend={false} />);
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });
});

describe('tickIndices', () => {
  it('labels every column when they all fit', () => {
    expect([...tickIndices(4, 6)]).toEqual([0, 1, 2, 3]);
  });

  it('always keeps the first and the last, and spaces the rest evenly', () => {
    expect([...tickIndices(30, 5)]).toEqual([0, 7, 15, 22, 29]);
  });

  it('has nothing to label for an empty series', () => {
    expect(tickIndices(0, 6).size).toBe(0);
  });
});

describe('StackedBarChart axis', () => {
  it('draws no axis unless asked', () => {
    const { container } = render(<StackedBarChart data={data} series={series} label="Usage" />);

    expect(container.querySelector('[data-slot="axis"]')).toBeNull();
  });

  it('labels every column for a handful of named categories', () => {
    const { container } = render(<StackedBarChart data={data} series={series} label="Usage" axis="all" />);
    const ticks = container.querySelector('[data-slot="axis"]') as HTMLElement;

    expect(Array.from(ticks.children).map((tick) => tick.textContent)).toEqual(['Mon', 'Tue', 'Wed']);
  });

  it('thins a long series but keeps one span per column, so ticks stay under their bars', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      id: `d-${index}`,
      label: `${index + 1} Aug`,
      values: { input: index, output: 0 },
    }));
    const { container } = render(
      <StackedBarChart data={many} series={series} label="Usage" axis="sparse" maxTicks={3} />,
    );
    const ticks = container.querySelector('[data-slot="axis"]') as HTMLElement;
    const labels = Array.from(ticks.children).map((tick) => tick.textContent);

    expect(labels).toHaveLength(30);
    expect(labels.filter(Boolean)).toEqual(['1 Aug', '16 Aug', '30 Aug']);
  });
});
