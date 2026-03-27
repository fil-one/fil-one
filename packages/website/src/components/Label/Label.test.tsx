import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Label } from './Label';

describe('Label', () => {
  it('renders children', () => {
    render(<Label>Email</Label>);
    expect(screen.getByText('Email')).toBeInTheDocument();
  });

  it('forwards htmlFor to the label element', () => {
    render(<Label htmlFor="email-input">Email</Label>);
    expect(screen.getByText('Email')).toHaveAttribute('for', 'email-input');
  });

  it('forwards ref to the label element', () => {
    const ref = { current: null as HTMLLabelElement | null };
    render(<Label ref={ref}>Email</Label>);
    expect(ref.current).toBeInstanceOf(HTMLLabelElement);
  });

  it('merges className', () => {
    render(<Label className="custom-class">Email</Label>);
    expect(screen.getByText('Email')).toHaveClass('custom-class');
  });

  it('applies default styles', () => {
    render(<Label>Email</Label>);
    const el = screen.getByText('Email');
    expect(el).toHaveClass('font-medium', 'text-zinc-700');
  });
});
