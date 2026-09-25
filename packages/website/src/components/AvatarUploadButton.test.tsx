import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { AvatarUploadButton } from './AvatarUploadButton';

describe('AvatarUploadButton', () => {
  it('renders the preview and hands over the picked file', () => {
    const onFile = vi.fn();
    const { container } = render(
      <AvatarUploadButton
        size="h-14 w-14"
        shape="rounded-full"
        iconSize={18}
        uploading={false}
        ariaLabel="Change avatar"
        accept="image/png"
        onFile={onFile}
      >
        <span>preview</span>
      </AvatarUploadButton>,
    );
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const click = vi.spyOn(input, 'click');

    expect(screen.getByText('preview')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change avatar' }));
    expect(click).toHaveBeenCalled();

    const file = new File(['x'], 'a.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onFile).toHaveBeenCalledWith(file);
  });
});
