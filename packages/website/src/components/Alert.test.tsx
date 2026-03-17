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
});
