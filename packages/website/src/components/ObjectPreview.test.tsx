import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { ObjectPreview } from './ObjectPreview.js';

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
