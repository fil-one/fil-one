import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { ObjectPreview } from './ObjectPreview';

function renderImage(url: string) {
  return <ObjectPreview state="ready" kind="image" url={url} fileName="any-file.png" />;
}

describe('ObjectPreview', () => {
  it('shows the next image after the previous one failed to load', () => {
    const { rerender } = render(renderImage('https://any-host/first.png'));
    fireEvent.error(screen.getByRole('img', { name: 'any-file.png' }));

    rerender(renderImage('https://any-host/second.png'));

    expect(screen.getByRole('img', { name: 'any-file.png' })).toMatchObject({
      src: 'https://any-host/second.png',
    });
  });
});
