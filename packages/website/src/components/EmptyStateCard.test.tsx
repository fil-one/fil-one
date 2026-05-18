import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyStateCard } from './EmptyStateCard';
import { DatabaseIcon } from '@phosphor-icons/react/dist/ssr';

describe('EmptyStateCard', () => {
  it('renders title and description', () => {
    render(<EmptyStateCard icon={DatabaseIcon} title="No items" description="Nothing to show" />);
    expect(screen.getByText('No items')).toBeInTheDocument();
    expect(screen.getByText('Nothing to show')).toBeInTheDocument();
  });

  it('renders children', () => {
    render(
      <EmptyStateCard icon={DatabaseIcon} title="Empty" description="desc">
        <button>Action</button>
      </EmptyStateCard>,
    );
    expect(screen.getByText('Action')).toBeInTheDocument();
  });
});
