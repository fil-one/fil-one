import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { AvatarUploadButton } from './AvatarUploadButton';

function renderButton(props: Partial<React.ComponentProps<typeof AvatarUploadButton>> = {}) {
  return render(
    <AvatarUploadButton
      size="h-14 w-14"
      shape="rounded-full"
      iconSize={18}
      uploading={false}
      ariaLabel="Change avatar"
      onClick={vi.fn()}
      {...props}
    >
      <span>preview</span>
    </AvatarUploadButton>,
  );
}

describe('AvatarUploadButton', () => {
  it('renders the preview and calls onClick', () => {
    const onClick = vi.fn();
    renderButton({ onClick });

    expect(screen.getByText('preview')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change avatar' }));
    expect(onClick).toHaveBeenCalled();
  });

  it('shows a spinner instead of the camera icon while uploading', () => {
    const { container, rerender } = renderButton({ uploading: false });
    expect(container.querySelector('svg')).toBeInTheDocument();

    rerender(
      <AvatarUploadButton
        size="h-14 w-14"
        shape="rounded-full"
        iconSize={18}
        uploading
        ariaLabel="Change avatar"
        onClick={vi.fn()}
      >
        <span>preview</span>
      </AvatarUploadButton>,
    );
    expect(container.querySelector('svg.animate-spin')).toBeInTheDocument();
  });

  it('disables the button when told to', () => {
    renderButton({ disabled: true });

    expect(screen.getByRole('button', { name: 'Change avatar' })).toBeDisabled();
  });

  it.each([['rounded-full'], ['rounded-xl']] as const)('applies the %s shape', (shape) => {
    renderButton({ shape });

    expect(screen.getByRole('button', { name: 'Change avatar' })).toHaveClass(shape);
  });
});
