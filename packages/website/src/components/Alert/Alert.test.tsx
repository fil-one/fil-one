import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Alert } from './Alert';

describe('Alert', () => {
  it('renders title and description', () => {
    render(<Alert title="Warning" description="Something happened" />);
    expect(screen.getByText('Warning')).toBeInTheDocument();
    expect(screen.getByText('Something happened')).toBeInTheDocument();
  });

  it('has alert role', () => {
    render(<Alert title="Warning" description="desc" />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('renders without description', () => {
    render(<Alert title="Info only" />);
    expect(screen.getByText('Info only')).toBeInTheDocument();
  });

  it('accepts className prop', () => {
    const { container } = render(<Alert title="Test" className="mt-4" />);
    expect(container.firstChild).toHaveClass('mt-4');
  });
});
