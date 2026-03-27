import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { StatCard } from './StatCard';

describe('StatCard', () => {
  it('renders label and value', () => {
    render(<StatCard label="Storage" value="1.5 GB" />);
    expect(screen.getByText('Storage')).toBeInTheDocument();
    expect(screen.getByText('1.5 GB')).toBeInTheDocument();
  });

  it('renders limit when provided', () => {
    render(<StatCard label="Storage" value="1.5 GB" limit="/ 10 GB" />);
    expect(screen.getByText('/ 10 GB')).toBeInTheDocument();
  });

  it('renders progress bar when progress is provided', () => {
    render(<StatCard label="Storage" value="1.5 GB" progress={50} />);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('renders usage when provided', () => {
    render(<StatCard label="Storage" value="1.5 GB" usage="15%" />);
    expect(screen.getByText('15%')).toBeInTheDocument();
  });

  it('accepts className prop', () => {
    const { container } = render(<StatCard label="Storage" value="1.5 GB" className="my-4" />);
    expect(container.firstChild).toHaveClass('my-4');
  });
});
