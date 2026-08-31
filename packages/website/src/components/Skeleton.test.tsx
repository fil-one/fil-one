import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';

import { Skeleton } from './Skeleton';

describe('Skeleton', () => {
  it('is decorative: hidden from assistive tech', () => {
    const { container } = render(<Skeleton />);
    expect(container.querySelector('[data-slot="skeleton"]')).toHaveAttribute('aria-hidden');
  });

  it('applies caller sizing and merges an overriding radius over the default', () => {
    const { container } = render(<Skeleton className="h-4 w-24 rounded-full" />);
    const el = container.querySelector('[data-slot="skeleton"]');
    expect(el).toHaveClass('h-4', 'w-24', 'animate-pulse', 'rounded-full');
    // cn (tailwind-merge) drops the default rounded-md when the caller sets a radius.
    expect(el).not.toHaveClass('rounded-md');
  });
});
