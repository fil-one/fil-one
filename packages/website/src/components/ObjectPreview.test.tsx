import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { S3Region } from '@filone/shared';

const getPreviewUrl = vi.hoisted(() =>
  vi.fn(({ objectKey }: { objectKey: string }) =>
    Promise.resolve({
      url: `https://any-host/${objectKey}`,
      // An hour away, so a failure reads as the file's own rather than a lapsed URL
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
  ),
);
vi.mock('../lib/preview-url.js', () => ({ getPreviewUrl }));

import { queryKeys } from '../lib/query-client.js';
import { ObjectPreview, ObjectPreviewCard } from './ObjectPreview.js';

function renderVideo(renewUrlIfLapsed: () => boolean, url = 'any-url') {
  return render(
    <ObjectPreview
      state="ready"
      kind="video"
      url={url}
      fileName="any-file.mp4"
      renewUrlIfLapsed={renewUrlIfLapsed}
    />,
  );
}

function getVideo(container: HTMLElement): HTMLVideoElement {
  const video = container.querySelector('video');
  if (!video) throw new Error('no video element rendered');
  return video;
}

describe('ObjectPreview media', () => {
  it('shows the failed placeholder when the media fails on a URL that has not lapsed', () => {
    const { container } = renderVideo(() => false);

    fireEvent.error(getVideo(container));

    expect(screen.getByText('Preview didn’t load')).toBeInTheDocument();
  });

  it('keeps the player and asks for a new URL when the media fails on a lapsed URL', () => {
    const renewUrlIfLapsed = vi.fn(() => true);
    const { container } = renderVideo(renewUrlIfLapsed);

    fireEvent.error(getVideo(container));

    expect(renewUrlIfLapsed).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Preview didn’t load')).not.toBeInTheDocument();
    expect(container.querySelector('video')).not.toBeNull();
  });

  it('resumes playing from where it stopped once the new URL loads', () => {
    const { container, rerender } = renderVideo(() => true, 'lapsed-url');
    const video = getVideo(container);
    // jsdom does not play media, so the element reports where it stood itself
    Object.defineProperty(video, 'paused', { value: false });
    video.currentTime = 42;
    const play = vi.fn(async () => undefined);
    video.play = play;

    fireEvent.error(video);
    video.currentTime = 0;
    rerender(
      <ObjectPreview
        state="ready"
        kind="video"
        url="new-url"
        fileName="any-file.mp4"
        renewUrlIfLapsed={() => true}
      />,
    );
    fireEvent.loadedMetadata(video);

    expect({ currentTime: video.currentTime, plays: play.mock.calls.length }).toStrictEqual({
      currentTime: 42,
      plays: 1,
    });
  });
});

describe('ObjectPreviewCard', () => {
  function renderCard(objectKey: string) {
    return (
      <ObjectPreviewCard
        bucketName="any-bucket"
        region={S3Region.EuWest1}
        objectKey={objectKey}
        sizeBytes={1024}
        contentType="image/png"
        onDownload={() => undefined}
      />
    );
  }

  it('shows the next object after the previous one failed to load', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Stepping back to an object seen before finds its URL cached, so the card
    // goes straight from one image to the next with no loading state between
    queryClient.setQueryData(queryKeys.objectPreviewUrl('any-bucket', 'second.png'), {
      url: 'https://any-host/second.png',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>{renderCard('first.png')}</QueryClientProvider>,
    );
    fireEvent.error(await screen.findByRole('img', { name: 'first.png' }));

    rerender(
      <QueryClientProvider client={queryClient}>{renderCard('second.png')}</QueryClientProvider>,
    );

    expect(await screen.findByRole('img', { name: 'second.png' })).toMatchObject({
      src: 'https://any-host/second.png',
    });
  });
});
