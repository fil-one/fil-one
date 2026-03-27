import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from './Button';

describe('Button', () => {
  it('renders children', () => {
    render(<Button variant="default">Click me</Button>);
    expect(screen.getByText('Click me')).toBeInTheDocument();
  });

  it('handles click events', () => {
    const onClick = vi.fn();
    render(
      <Button variant="default" onClick={onClick}>
        Click
      </Button>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('renders as disabled', () => {
    render(
      <Button variant="default" disabled>
        Disabled
      </Button>,
    );
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('renders as a child element when asChild is true', () => {
    render(
      <Button variant="default" asChild>
        <a href="/test">Link</a>
      </Button>,
    );
    expect(screen.getByRole('link')).toHaveAttribute('href', '/test');
  });
});
