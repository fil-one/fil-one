import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { S3Region } from '@filone/shared';

const batchPresign = vi.hoisted(() =>
  vi.fn(() => Promise.resolve({ items: [{ url: 'https://any-host/signed.png' }] })),
);
vi.mock('../lib/use-presign.js', () => ({ batchPresign }));

import { ObjectPreview, ObjectPreviewCard } from './ObjectPreview';

const FAILED = 'Preview didn’t load';

function renderImage(url: string, onRefreshUrl?: () => void) {
  return (
    <ObjectPreview
      state="ready"
      kind="image"
      url={url}
      fileName="any-file.png"
      onRefreshUrl={onRefreshUrl}
    />
  );
}

function renderVideo(url: string, onRefreshUrl: () => void) {
  return (
    <ObjectPreview
      state="ready"
      kind="video"
      url={url}
      fileName="any-file.mp4"
      onRefreshUrl={onRefreshUrl}
    />
  );
}

function getVideo(container: HTMLElement): HTMLVideoElement {
  const video = container.querySelector('video');
  if (!video) throw new Error('No video rendered');
  return video;
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

  it('asks for a new URL instead of showing the failure when an image fails to load', () => {
    const onRefreshUrl = vi.fn();
    render(renderImage('https://any-host/lapsed.png', onRefreshUrl));

    fireEvent.error(screen.getByRole('img', { name: 'any-file.png' }));

    expect(onRefreshUrl).toHaveBeenCalledOnce();
    expect(screen.queryByText(FAILED)).toBeNull();
  });

  it('shows the failure when the new URL fails to load too', () => {
    const onRefreshUrl = vi.fn();
    const { rerender } = render(renderImage('https://any-host/lapsed.png', onRefreshUrl));
    fireEvent.error(screen.getByRole('img', { name: 'any-file.png' }));

    rerender(renderImage('https://any-host/fresh.png', onRefreshUrl));
    fireEvent.error(screen.getByRole('img', { name: 'any-file.png' }));

    expect(onRefreshUrl).toHaveBeenCalledOnce();
    expect(screen.getByText(FAILED)).toBeTruthy();
  });

  it('asks for a new URL again when a refreshed URL loaded and later lapsed', () => {
    const onRefreshUrl = vi.fn();
    const { rerender } = render(renderImage('https://any-host/first.png', onRefreshUrl));
    fireEvent.error(screen.getByRole('img', { name: 'any-file.png' }));
    rerender(renderImage('https://any-host/second.png', onRefreshUrl));
    fireEvent.load(screen.getByRole('img', { name: 'any-file.png' }));

    fireEvent.error(screen.getByRole('img', { name: 'any-file.png' }));

    expect(onRefreshUrl).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(FAILED)).toBeNull();
  });

  it('returns a video to where it was paused once the new URL loads', () => {
    const { container, rerender } = render(renderVideo('https://any-host/lapsed.mp4', vi.fn()));
    getVideo(container).currentTime = 42;
    fireEvent.error(getVideo(container));

    rerender(renderVideo('https://any-host/fresh.mp4', vi.fn()));
    getVideo(container).currentTime = 0; // a new source starts from the beginning
    fireEvent.loadedMetadata(getVideo(container));

    expect(getVideo(container).currentTime).toBe(42);
  });
});

describe('ObjectPreviewCard', () => {
  // Trial accounts cannot mint shareable links, which the backend recognises by a
  // custom `expiresIn`. A preview signed with the default lifetime works on every plan.
  it('signs the preview URL with the default lifetime, so trial accounts get a preview', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ObjectPreviewCard
          bucketName="any-bucket"
          region={S3Region.UsEast1}
          objectKey="any-file.png"
          versionId="any-version"
          sizeBytes={1024}
          contentType="image/png"
          onDownload={() => {}}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(batchPresign).toHaveBeenCalled());
    expect(batchPresign).toHaveBeenCalledWith(S3Region.UsEast1, [
      { op: 'getObject', bucket: 'any-bucket', key: 'any-file.png', versionId: 'any-version' },
    ]);
  });
});
