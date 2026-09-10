import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { OrgAvatar } from './OrgAvatar';

describe('OrgAvatar', () => {
  it('renders the initial when there is no logo', () => {
    const { container } = render(<OrgAvatar name="Fil One" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('F');
  });

  it('renders the logo over the initial while it loads', () => {
    const { container } = render(
      <OrgAvatar name="Fil One" logoUrl="https://example.com/logo.png" />,
    );
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://example.com/logo.png');
    // The initial stays underneath so a slow logo never leaves an empty square.
    expect(container.textContent).toBe('F');
  });

  it('hides the initial once the logo has loaded', () => {
    const { container } = render(
      <OrgAvatar name="Fil One" logoUrl="https://example.com/logo.png" />,
    );
    fireEvent.load(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeInTheDocument();
    expect(container.textContent).toBe('');
  });

  it('falls back to the initial when the logo fails to load', () => {
    const { container } = render(
      <OrgAvatar name="Fil One" logoUrl="https://example.com/broken.png" />,
    );
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('F');
  });

  it('retries once a new logo URL arrives after a failure', () => {
    const { container, rerender } = render(
      <OrgAvatar name="Fil One" logoUrl="https://example.com/broken.png" />,
    );
    fireEvent.error(container.querySelector('img')!);
    rerender(<OrgAvatar name="Fil One" logoUrl="https://example.com/fresh.png" />);
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://example.com/fresh.png');
  });

  it('falls back to "?" when the name is empty', () => {
    const { container } = render(<OrgAvatar name="" />);
    expect(container.textContent).toBe('?');
  });

  it.each([
    ['xs', 'h-4', 'w-4', 'rounded-sm'],
    ['sm', 'h-7', 'w-7', 'rounded-md'],
    ['md', 'h-14', 'w-14', 'rounded-xl'],
    ['lg', 'h-16', 'w-16', 'rounded-xl'],
  ] as const)('renders the %s size with its own dimensions and radius', (size, h, w, rounded) => {
    const { container } = render(<OrgAvatar name="Fil One" size={size} />);
    const avatar = container.firstElementChild;
    expect(avatar).toHaveClass(h, w, rounded);
  });

  it('defaults to the sm size', () => {
    const { container } = render(<OrgAvatar name="Fil One" />);
    expect(container.firstElementChild).toHaveClass('h-7', 'w-7', 'rounded-md');
  });

  it('is always the same dark grey, whatever the org is named', () => {
    const { container: a } = render(<OrgAvatar name="Acme" />);
    const { container: b } = render(<OrgAvatar name="Fil One" />);
    expect(a.firstElementChild).toHaveClass('bg-zinc-700');
    expect(b.firstElementChild).toHaveClass('bg-zinc-700');
  });
});
