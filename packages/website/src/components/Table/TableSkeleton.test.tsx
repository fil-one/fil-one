import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { TableSkeleton, type SkeletonColumn } from './TableSkeleton';

const COLUMNS: SkeletonColumn[] = [
  { label: 'Name' },
  { label: 'Region', className: 'hidden sm:table-cell' },
  { label: 'Created', className: 'hidden sm:table-cell' },
  {},
];

describe('TableSkeleton', () => {
  it('exposes a labelled loading status', () => {
    render(<TableSkeleton columns={COLUMNS} aria-label="Loading buckets" />);
    expect(screen.getByRole('status', { name: 'Loading buckets' })).toBeInTheDocument();
  });

  it('shows real header labels rather than placeholders', () => {
    render(<TableSkeleton columns={COLUMNS} />);
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Region')).toBeInTheDocument();
    expect(screen.getByText('Created')).toBeInTheDocument();
  });

  it('renders one body cell per column per row', () => {
    const { container } = render(<TableSkeleton columns={COLUMNS} rows={3} />);
    expect(container.querySelectorAll('thead th')).toHaveLength(4);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(container.querySelectorAll('tbody td')).toHaveLength(12);
  });

  it("carries each column's responsive class on both the header and its body cells", () => {
    const { container } = render(<TableSkeleton columns={COLUMNS} rows={1} />);
    const headerCells = container.querySelectorAll('thead th');
    expect(headerCells[0]).not.toHaveClass('hidden');
    expect(headerCells[1]).toHaveClass('hidden', 'sm:table-cell');

    const bodyCells = container.querySelectorAll('tbody td');
    expect(bodyCells[0]).not.toHaveClass('hidden');
    expect(bodyCells[1]).toHaveClass('hidden', 'sm:table-cell');
  });
});
