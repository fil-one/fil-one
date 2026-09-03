import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from './Button';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  // `BaseLink` reads the active org's slug through this to prefix internal
  // `href`s; no org context here, so the unprefixed path is what renders.
  useParams: () => ({}),
}));

describe('Button', () => {
  it('renders children', () => {
    render(<Button variant="primary">Click me</Button>);
    expect(screen.getByText('Click me')).toBeInTheDocument();
  });

  it('handles click events', () => {
    const onClick = vi.fn();
    render(
      <Button variant="primary" onClick={onClick}>
        Click
      </Button>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('renders as disabled', () => {
    render(
      <Button variant="primary" disabled>
        Disabled
      </Button>,
    );
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('renders as a link when href is provided', () => {
    render(
      <Button variant="primary" href="/test">
        Link
      </Button>,
    );
    expect(screen.getByText('Link').closest('a')).toHaveAttribute('href', '/test');
  });
});
