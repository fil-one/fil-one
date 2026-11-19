import { useRef, useState } from 'react';
import type { SyntheticEvent } from 'react';
import { DownloadSimpleIcon, FileIcon, WarningCircleIcon } from '@phosphor-icons/react/dist/ssr';
import { useQuery } from '@tanstack/react-query';

import { formatBytes } from '@filone/shared';
import type { S3Region } from '@filone/shared';

import { Button } from './Button';
import { Card } from './Card';
import { EmptyStateCard } from './EmptyStateCard';
import { Skeleton } from './Skeleton';
import { executePresignedUrl } from '../lib/aurora-s3.js';
import {
  getObjectFileName,
  getPreviewKind,
  isWithinPreviewLimit,
  PREVIEW_SIZE_LIMITS,
  TEXT_PREVIEW_MAX_CHARS,
  type PreviewKind,
} from '../lib/object-preview.js';
import { getPreviewUrl } from '../lib/preview-url.js';
import { queryKeys } from '../lib/query-client.js';

// How long before a URL lapses the card treats it as lapsed, so a remount
// fetches a fresh one rather than showing one about to expire.
const PREVIEW_URL_REFRESH_MARGIN_MS = 60 * 1000;

/** Why there is no preview, which decides what the placeholder says. */
export type NoPreviewReason = 'unsupported' | 'too-large' | 'failed';

export type ObjectPreviewProps =
  | { state: 'loading'; kind: PreviewKind }
  | {
      state: 'ready';
      kind: 'image' | 'video' | 'audio';
      url: string;
      fileName: string;
      /**
       * Called when the media fails to load. Asks for a new URL and returns
       * true when the current one has lapsed; false means the failure is real.
       */
      renewUrlIfLapsed: () => boolean;
    }
  | { state: 'ready'; kind: 'text'; text: string; truncated: boolean }
  | {
      state: 'none';
      reason: NoPreviewReason;
      kind: PreviewKind | null;
      sizeBytes: number;
      onDownload: () => void;
    };

/**
 * The object itself, as far as the browser can show it: an image, a player, or
 * the first stretch of a text file. Anything else gets a placeholder that says
 * why and offers the download, so the card never sits empty.
 */
export function ObjectPreview(props: ObjectPreviewProps) {
  return (
    <Card padding="none" className="overflow-hidden" data-testid="object-preview">
      <ObjectPreviewBody {...props} />
    </Card>
  );
}

function ObjectPreviewBody(props: ObjectPreviewProps) {
  if (props.state === 'loading') {
    return (
      <div role="status" aria-label="Loading preview" className="p-4">
        <Skeleton className={props.kind === 'audio' ? 'h-10' : 'h-64'} />
      </div>
    );
  }
  if (props.state === 'none') {
    return <NoPreview {...props} />;
  }
  if (props.kind === 'text') {
    return <TextPreview text={props.text} truncated={props.truncated} />;
  }
  return <MediaPreview {...props} />;
}

/** Where a player stood when its URL lapsed, so it can carry on from there. */
interface PlaybackPosition {
  time: number;
  playing: boolean;
}

function MediaPreview({
  kind,
  url,
  fileName,
  renewUrlIfLapsed,
}: {
  kind: 'image' | 'video' | 'audio';
  url: string;
  fileName: string;
  renewUrlIfLapsed: () => boolean;
}) {
  const [failed, setFailed] = useState(false);
  const resumeFrom = useRef<PlaybackPosition | null>(null);

  // A player streams on demand, so its URL can lapse mid-play. The new URL
  // reloads the element from the start, so the position is kept to resume at.
  const handleError = (event: SyntheticEvent<HTMLImageElement | HTMLMediaElement>) => {
    if (!renewUrlIfLapsed()) {
      setFailed(true);
      return;
    }
    const element = event.currentTarget;
    if (element instanceof HTMLMediaElement) {
      resumeFrom.current = { time: element.currentTime, playing: !element.paused };
    }
  };
  const resumePlayback = (event: SyntheticEvent<HTMLMediaElement>) => {
    const position = resumeFrom.current;
    if (!position) return;
    resumeFrom.current = null;
    const element = event.currentTarget;
    element.currentTime = position.time;
    // The browser may refuse to play without a fresh gesture; the controls stay
    if (position.playing) element.play().catch(() => undefined);
  };

  if (failed) {
    return <NoPreviewMessage />;
  }
  if (kind === 'audio') {
    return (
      <div className="p-4">
        <audio
          controls
          preload="metadata"
          src={url}
          className="w-full"
          onError={handleError}
          onLoadedMetadata={resumePlayback}
        >
          <track kind="captions" />
        </audio>
      </div>
    );
  }
  return (
    // A quiet backdrop so a white or transparent image still shows its edges
    <div className="flex items-center justify-center bg-zinc-50 p-4">
      {kind === 'image' ? (
        <img
          src={url}
          alt={fileName}
          className="max-h-96 max-w-full rounded-md object-contain"
          onError={handleError}
        />
      ) : (
        <video
          controls
          // Metadata only until the user presses play: the file streams on demand
          preload="metadata"
          src={url}
          className="max-h-96 max-w-full rounded-md"
          onError={handleError}
          onLoadedMetadata={resumePlayback}
        >
          <track kind="captions" />
        </video>
      )}
    </div>
  );
}

function TextPreview({ text, truncated }: { text: string; truncated: boolean }) {
  return (
    <>
      <pre
        tabIndex={0}
        aria-label="File contents"
        className="max-h-96 overflow-auto p-4 font-mono text-meta leading-5 break-words whitespace-pre-wrap text-zinc-800 focus-visible:brand-outline"
      >
        {text}
      </pre>
      {truncated && (
        <p className="border-t border-zinc-100 px-4 py-2 text-xs text-zinc-500">
          Showing the first {TEXT_PREVIEW_MAX_CHARS.toLocaleString()} characters. Download the file
          to see the rest.
        </p>
      )}
    </>
  );
}

function getNoPreviewCopy(
  reason: NoPreviewReason,
  kind: PreviewKind | null,
  sizeBytes: number,
): { title: string; description: string } {
  if (reason === 'too-large' && (kind === 'image' || kind === 'text')) {
    return {
      title: 'Too large to preview',
      description: `This file is ${formatBytes(sizeBytes)}. Previews load ${kind === 'image' ? 'images' : 'text files'} up to ${formatBytes(PREVIEW_SIZE_LIMITS[kind])}.`,
    };
  }
  if (reason === 'failed') {
    return {
      title: 'Preview didn’t load',
      description: 'Your browser couldn’t display this file. Download it to open it locally.',
    };
  }
  return {
    title: 'No preview for this file type',
    description: 'Previews cover images, video, audio, and text files.',
  };
}

function NoPreview({
  reason,
  kind,
  sizeBytes,
  onDownload,
}: Extract<ObjectPreviewProps, { state: 'none' }>) {
  const { title, description } = getNoPreviewCopy(reason, kind, sizeBytes);
  return (
    <EmptyStateCard
      icon={reason === 'failed' ? WarningCircleIcon : FileIcon}
      iconColor="grey"
      title={title}
      description={description}
      bordered={false}
    >
      <Button variant="ghost" size="sm" icon={DownloadSimpleIcon} onClick={onDownload}>
        Download
      </Button>
    </EmptyStateCard>
  );
}

/**
 * The placeholder for a player or image that failed after its URL arrived. No
 * button: the header's Download is a glance away.
 */
function NoPreviewMessage() {
  const { title, description } = getNoPreviewCopy('failed', null, 0);
  return (
    <EmptyStateCard
      icon={WarningCircleIcon}
      iconColor="grey"
      title={title}
      description={description}
      bordered={false}
    />
  );
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export type ObjectPreviewCardProps = {
  bucketName: string;
  region: S3Region;
  objectKey: string;
  versionId?: string;
  /** Changes whenever the contents do, so the text preview never shows an overwritten file. */
  etag?: string;
  sizeBytes: number;
  contentType?: string;
  onDownload: () => void;
};

async function fetchPreviewText(url: string): Promise<{ text: string; truncated: boolean }> {
  const response = await executePresignedUrl(url, 'GET');
  const text = await response.text();
  return {
    text: text.slice(0, TEXT_PREVIEW_MAX_CHARS),
    truncated: text.length > TEXT_PREVIEW_MAX_CHARS,
  };
}

/** Fetches what `ObjectPreview` shows: a signed URL, and for text, the file's contents. */
export function ObjectPreviewCard({
  bucketName,
  region,
  objectKey,
  versionId,
  etag,
  sizeBytes,
  contentType,
  onDownload,
}: ObjectPreviewCardProps) {
  const kind = getPreviewKind(objectKey, contentType);
  const loadable = kind !== null && isWithinPreviewLimit(kind, sizeBytes);

  const urlQuery = useQuery({
    queryKey: queryKeys.objectPreviewUrl(bucketName, objectKey, versionId),
    enabled: loadable,
    // The URL is short-lived, so its own expiry decides when it goes stale.
    // A refocus or reconnect does not refetch: a new URL would reload a player
    // the user paused, and `renewUrlIfLapsed` replaces one that lapses in use.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: (query) => {
      const expiresAt = query.state.data?.expiresAt;
      return expiresAt ? Date.parse(expiresAt) - Date.now() - PREVIEW_URL_REFRESH_MARGIN_MS : 0;
    },
    queryFn: () => getPreviewUrl({ region, bucketName, objectKey, versionId }),
  });
  const url = urlQuery.data?.url;
  const renewUrlIfLapsed = () => {
    const expiresAt = urlQuery.data?.expiresAt;
    if (!expiresAt || Date.parse(expiresAt) - Date.now() > PREVIEW_URL_REFRESH_MARGIN_MS) {
      return false;
    }
    void urlQuery.refetch();
    return true;
  };

  const textQuery = useQuery({
    // Without a version ID the key alone names whatever is latest, so the ETag
    // tells a cached body from the contents of a file overwritten since
    queryKey: [...queryKeys.objectPreviewUrl(bucketName, objectKey, versionId), 'text', etag],
    enabled: kind === 'text' && url !== undefined,
    // The key carries the ETag, so a cached body stays true to the contents. A
    // refetch could also run on a URL that has since lapsed.
    staleTime: Infinity,
    // `enabled` holds this back until the URL has arrived
    queryFn: () => fetchPreviewText(url ?? ''),
  });

  if (!loadable) {
    return (
      <ObjectPreview
        state="none"
        reason={kind === null ? 'unsupported' : 'too-large'}
        kind={kind}
        sizeBytes={sizeBytes}
        onDownload={onDownload}
      />
    );
  }
  if (urlQuery.isError || textQuery.isError) {
    return (
      <ObjectPreview
        state="none"
        reason="failed"
        kind={kind}
        sizeBytes={sizeBytes}
        onDownload={onDownload}
      />
    );
  }
  if (kind === 'text') {
    return textQuery.data ? (
      <ObjectPreview state="ready" kind="text" {...textQuery.data} />
    ) : (
      <ObjectPreview state="loading" kind="text" />
    );
  }
  return url ? (
    <ObjectPreview
      state="ready"
      kind={kind}
      url={url}
      fileName={getObjectFileName(objectKey)}
      renewUrlIfLapsed={renewUrlIfLapsed}
    />
  ) : (
    <ObjectPreview state="loading" kind={kind} />
  );
}
