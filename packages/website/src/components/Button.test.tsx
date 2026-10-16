import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from './Button';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
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

  it('stops taking clicks while loading and says it is busy', () => {
    const onClick = vi.fn();
    render(
      <Button variant="destructive" loading loadingLabel="Deleting bucket" onClick={onClick}>
        Delete bucket
      </Button>,
    );
    const button = screen.getByRole('button', { name: /Delete bucket/ });
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByLabelText('Deleting bucket')).toBeInTheDocument();
  });

  it('shows the spinner in place of the icon, not beside it', () => {
    render(
      <Button variant="primary" icon={() => <svg data-testid="icon" />} loading>
        Send
      </Button>,
    );
    expect(screen.queryByTestId('icon')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders a loading link as a button, so it cannot be followed', () => {
    render(
      <Button variant="primary" href="/test" loading>
        Link
      </Button>,
    );
    expect(screen.getByText('Link').closest('a')).toBeNull();
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
