import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Icon } from './Icon';
import { CheckIcon } from '@phosphor-icons/react/dist/ssr';

describe('Icon', () => {
  it('renders with aria-hidden', () => {
    const { container } = render(<Icon component={CheckIcon} />);
    expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
  });

  it('renders with custom size', () => {
    const { container } = render(<Icon component={CheckIcon} size={32} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '32');
    expect(svg).toHaveAttribute('height', '32');
  });
});
