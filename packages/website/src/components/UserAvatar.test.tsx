import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { UserAvatar } from './UserAvatar';

describe('UserAvatar', () => {
  it('renders the initial when there is no picture', () => {
    const { container } = render(<UserAvatar initial="F" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('F');
  });

  it('renders the picture over the initial while it loads', () => {
    const { container } = render(
      <UserAvatar src="https://avatars.githubusercontent.com/u/1" initial="F" />,
    );
    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      'https://avatars.githubusercontent.com/u/1',
    );
    // The initial stays underneath so a slow picture never leaves an empty circle.
    expect(container.textContent).toBe('F');
  });

  it('hides the initial once the picture has loaded', () => {
    const { container } = render(<UserAvatar src="https://example.com/me.png" initial="F" />);
    fireEvent.load(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeInTheDocument();
    expect(container.textContent).toBe('');
  });

  // The fill would otherwise show at the rounded edge as a hairline.
  it('drops the fill behind a picture that has loaded, a caller-supplied fill included', () => {
    const { container } = render(
      <UserAvatar src="https://example.com/me.png" initial="F" className="bg-zinc-700" />,
    );
    fireEvent.load(container.querySelector('img')!);
    expect(container.firstElementChild).toHaveClass('bg-transparent');
    expect(container.firstElementChild).not.toHaveClass('bg-zinc-700', 'bg-zinc-200');
  });

  it('keeps the fill behind the initial while the picture loads', () => {
    const { container } = render(
      <UserAvatar src="https://example.com/me.png" initial="F" className="bg-zinc-700" />,
    );
    expect(container.firstElementChild).toHaveClass('bg-zinc-700');
  });

  it('falls back to the initial when the picture fails to load', () => {
    const { container } = render(<UserAvatar src="https://example.com/broken.png" initial="F" />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('F');
  });

  it('retries once a new picture URL arrives after a failure', () => {
    const { container, rerender } = render(
      <UserAvatar src="https://example.com/broken.png" initial="F" />,
    );
    fireEvent.error(container.querySelector('img')!);
    rerender(<UserAvatar src="https://example.com/fresh.png" initial="F" />);
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://example.com/fresh.png');
  });
});
