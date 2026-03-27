import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Icon } from './Icon';
import { CheckIcon } from '@phosphor-icons/react/dist/ssr';

describe('Icon', () => {
  it('renders with aria-hidden', () => {
    const { container } = render(<Icon component={CheckIcon} />);
    expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
  });

  it('renders with sm size (16px)', () => {
    const { container } = render(<Icon component={CheckIcon} size="sm" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '16');
    expect(svg).toHaveAttribute('height', '16');
  });

  it('renders with md size (20px)', () => {
    const { container } = render(<Icon component={CheckIcon} size="md" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '20');
    expect(svg).toHaveAttribute('height', '20');
  });

  it('renders with lg size (24px) by default', () => {
    const { container } = render(<Icon component={CheckIcon} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '24');
    expect(svg).toHaveAttribute('height', '24');
  });
});
