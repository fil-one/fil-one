import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CheckCircleIcon } from '@phosphor-icons/react/dist/ssr';

import { IconBadge } from './IconBadge';

describe('IconBadge', () => {
  it('renders with aria-hidden icon', () => {
    const { container } = render(<IconBadge icon={CheckCircleIcon} />);
    expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
  });

  it('applies sm size class by default', () => {
    const { container } = render(<IconBadge icon={CheckCircleIcon} />);
    expect(container.firstChild).toHaveClass('size-9');
  });

  it('applies lg size class', () => {
    const { container } = render(<IconBadge icon={CheckCircleIcon} size="lg" />);
    expect(container.firstChild).toHaveClass('size-15');
  });

  it('applies info variant by default', () => {
    const { container } = render(<IconBadge icon={CheckCircleIcon} />);
    expect(container.firstChild).toHaveClass('bg-zinc-200/60');
  });

  it('applies brand variant', () => {
    const { container } = render(<IconBadge icon={CheckCircleIcon} variant="brand" />);
    expect(container.firstChild).toHaveClass('bg-brand-50');
  });

  it('accepts className prop', () => {
    const { container } = render(<IconBadge icon={CheckCircleIcon} className="my-2" />);
    expect(container.firstChild).toHaveClass('my-2');
  });
});
