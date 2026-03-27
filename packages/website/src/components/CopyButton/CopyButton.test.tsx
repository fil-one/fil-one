import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { CopyButton } from './CopyButton';

vi.mock('../../components/Toast/index.js', () => ({
  useToast: () => ({ toast: { error: vi.fn() } }),
}));

Object.assign(navigator, {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

describe('CopyButton', () => {
  it('renders with default aria-label', () => {
    render(<CopyButton value="test" />);
    expect(screen.getByRole('button', { name: 'Copy to clipboard' })).toBeInTheDocument();
  });

  it('renders with custom aria-label', () => {
    render(<CopyButton value="test" ariaLabel="Copy endpoint" />);
    expect(screen.getByRole('button', { name: 'Copy endpoint' })).toBeInTheDocument();
  });

  it('copies value to clipboard on click', () => {
    render(<CopyButton value="https://s3.fil.one" />);
    fireEvent.click(screen.getByRole('button'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://s3.fil.one');
  });

  it('accepts className prop', () => {
    render(<CopyButton value="test" className="size-7" />);
    expect(screen.getByRole('button')).toHaveClass('size-7');
  });
});
