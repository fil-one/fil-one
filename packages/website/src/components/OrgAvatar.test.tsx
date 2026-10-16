import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { OrgAvatar } from './OrgAvatar';

// The image fallback is `UserAvatar`'s, and tested there.
describe('OrgAvatar', () => {
  it('renders the initial when there is no logo', () => {
    const { container } = render(<OrgAvatar name="Fil One" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('F');
  });

  it('renders the logo when there is one', () => {
    const { container } = render(
      <OrgAvatar name="Fil One" logoUrl="https://example.com/logo.png" />,
    );
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://example.com/logo.png');
  });

  it('falls back to "?" when the name is empty', () => {
    const { container } = render(<OrgAvatar name="" />);
    expect(container.textContent).toBe('?');
  });

  it.each([
    [undefined, 'h-7', 'w-7', 'rounded-md'],
    ['xs', 'h-4', 'w-4', 'rounded-sm'],
    ['sm', 'h-7', 'w-7', 'rounded-md'],
    ['md', 'h-14', 'w-14', 'rounded-xl'],
    ['lg', 'h-16', 'w-16', 'rounded-xl'],
  ] as const)('renders the %s size as a dark grey square', (size, h, w, rounded) => {
    const { container } = render(<OrgAvatar name="Fil One" size={size} />);
    const avatar = container.firstElementChild;
    expect(avatar).toHaveClass(h, w, rounded, 'bg-zinc-700');
    expect(avatar).not.toHaveClass('rounded-full', 'bg-zinc-200');
  });
});
