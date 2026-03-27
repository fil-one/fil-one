import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EmptyStateCard } from './EmptyStateCard';
import { DatabaseIcon } from '@phosphor-icons/react/dist/ssr';

const defaultProps = {
  icon: DatabaseIcon,
  title: 'No items',
  titleTag: 'h2' as const,
  description: 'Nothing to show',
};

describe('EmptyStateCard', () => {
  it('renders title and description', () => {
    render(<EmptyStateCard {...defaultProps} />);
    expect(screen.getByText('No items')).toBeInTheDocument();
    expect(screen.getByText('Nothing to show')).toBeInTheDocument();
  });

  it('renders children', () => {
    render(
      <EmptyStateCard {...defaultProps}>
        <button>Custom child</button>
      </EmptyStateCard>,
    );
    expect(screen.getByText('Custom child')).toBeInTheDocument();
  });

  it('renders action button when action prop is provided', () => {
    render(<EmptyStateCard {...defaultProps} action={{ label: 'Upload file' }} />);
    expect(screen.getByRole('button', { name: 'Upload file' })).toBeInTheDocument();
  });

  it('calls action.onClick when action button is clicked', () => {
    const onClick = vi.fn();
    render(<EmptyStateCard {...defaultProps} action={{ label: 'Go', onClick }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders action as a link when href is provided', () => {
    render(
      <EmptyStateCard
        {...defaultProps}
        action={{ label: 'Create bucket', href: '/buckets/new' }}
      />,
    );
    const link = screen.getByRole('link', { name: 'Create bucket' });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/buckets/new');
  });

  it('renders no action when action prop is omitted', () => {
    render(<EmptyStateCard {...defaultProps} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
