import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { IconButton } from './IconButton';

describe('IconButton', () => {
  it('renders children', () => {
    render(<IconButton aria-label="Test">icon</IconButton>);
    expect(screen.getByRole('button', { name: 'Test' })).toHaveTextContent('icon');
  });

  it('defaults to type="button"', () => {
    render(<IconButton aria-label="Test">icon</IconButton>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
  });

  it('handles click events', () => {
    const onClick = vi.fn();
    render(
      <IconButton aria-label="Test" onClick={onClick}>
        icon
      </IconButton>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('accepts className prop', () => {
    render(
      <IconButton aria-label="Test" className="size-7">
        icon
      </IconButton>,
    );
    expect(screen.getByRole('button')).toHaveClass('size-7');
  });
});
