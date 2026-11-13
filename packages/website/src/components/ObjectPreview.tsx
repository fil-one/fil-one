import { useRef, useState, type SyntheticEvent } from 'react';
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
import { queryKeys } from '../lib/query-client.js';
import { batchPresign } from '../lib/use-presign.js';

// The preview asks for a URL with the default lifetime of five minutes. A custom
// lifetime would make it a shareable link, which trial accounts cannot mint. A
// panel opened again after four minutes signs a new URL, and a player that
// outlives its URL signs one when it next fails to load (see `MediaPreview`).
const PREVIEW_URL_STALE_TIME = 4 * 60 * 1000;
// The text is read once and keyed by the ETag, so it stays good far longer than the URL
const PREVIEW_TEXT_STALE_TIME = 50 * 60 * 1000;

/** Why there is no preview, which decides what the placeholder says. */
export type NoPreviewReason = 'unsupported' | 'too-large' | 'failed';

export type ObjectPreviewProps =
  | { state: 'loading'; kind: PreviewKind }
  | {
      state: 'ready';
      kind: 'image' | 'video' | 'audio';
      url: string;
      fileName: string;
      /** Signs a new URL after this one fails, as it does once it lapses. */
      onRefreshUrl?: () => void;
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
  return (
    <MediaPreview
      kind={props.kind}
      url={props.url}
      fileName={props.fileName}
      onRefreshUrl={props.onRefreshUrl}
    />
  );
}

/**
 * An image or player for a signed URL that lapses after a few minutes. Players
 * fetch as they play and seek, so a paused video can outlive its URL. When a
 * load fails, the preview asks for a new URL once and picks up where playback
 * stood. Failing again before anything loads means the file itself cannot be
 * shown.
 */
function MediaPreview({
  kind,
  url,
  fileName,
  onRefreshUrl,
}: {
  kind: 'image' | 'video' | 'audio';
  url: string;
  fileName: string;
  onRefreshUrl?: () => void;
}) {
  // A failure belongs to one URL, so stepping to another object, or a new URL
  // for this one, gets a fresh attempt
  const [failedUrl, setFailedUrl] = useState<string>();
  // Set while waiting for the URL asked for after a failure; cleared once anything loads
  const refreshing = useRef(false);
  // Where playback stood when the URL lapsed, to return to once the new one loads
  const resumeAt = useRef<number>(undefined);

  const handleError = (event: SyntheticEvent<HTMLElement>) => {
    if (refreshing.current || !onRefreshUrl) {
      refreshing.current = false;
      setFailedUrl(url);
      return;
    }
    refreshing.current = true;
    if (event.currentTarget instanceof HTMLMediaElement) {
      resumeAt.current = event.currentTarget.currentTime;
    }
    onRefreshUrl();
  };
  const handleLoad = () => {
    refreshing.current = false;
  };
  const handleLoadedMetadata = (event: SyntheticEvent<HTMLMediaElement>) => {
    refreshing.current = false;
    if (resumeAt.current) event.currentTarget.currentTime = resumeAt.current;
    resumeAt.current = undefined;
  };

  if (failedUrl === url) {
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
          onLoadedMetadata={handleLoadedMetadata}
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
          onLoad={handleLoad}
        />
      ) : (
        <video
          controls
          // Metadata only until the user presses play: the file streams on demand
          preload="metadata"
          src={url}
          className="max-h-96 max-w-full rounded-md"
          onError={handleError}
          onLoadedMetadata={handleLoadedMetadata}
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

type PreviewTarget = {
  bucketName: string;
  region: S3Region;
  objectKey: string;
  versionId?: string;
};

async function signPreviewUrl({
  bucketName,
  region,
  objectKey,
  versionId,
}: PreviewTarget): Promise<string> {
  const { items } = await batchPresign(region, [
    { op: 'getObject', bucket: bucketName, key: objectKey, ...(versionId && { versionId }) },
  ]);
  return items[0].url;
}

// Signs its own URL rather than reusing the media one, which may have lapsed by the
// time a cached text goes stale
async function fetchPreviewText(
  target: PreviewTarget,
): Promise<{ text: string; truncated: boolean }> {
  const response = await executePresignedUrl(await signPreviewUrl(target), 'GET');
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
  const target = { bucketName, region, objectKey, versionId };

  const urlQuery = useQuery({
    queryKey: queryKeys.objectPreviewUrl(bucketName, objectKey, versionId),
    enabled: loadable && kind !== 'text',
    staleTime: PREVIEW_URL_STALE_TIME,
    // A new URL reloads the player, so it changes only when the panel opens or a
    // load fails, never because the window regained focus
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: () => signPreviewUrl(target),
  });

  const textQuery = useQuery({
    // Without a version ID the key alone names whatever is latest, so the ETag
    // tells a cached body from the contents of a file overwritten since
    queryKey: [...queryKeys.objectPreviewUrl(bucketName, objectKey, versionId), 'text', etag],
    enabled: loadable && kind === 'text',
    staleTime: PREVIEW_TEXT_STALE_TIME,
    queryFn: () => fetchPreviewText(target),
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
  return urlQuery.data ? (
    <ObjectPreview
      // A new object starts with no failure or playback position from the last one
      key={`${objectKey}\n${versionId ?? ''}`}
      state="ready"
      kind={kind}
      url={urlQuery.data}
      fileName={getObjectFileName(objectKey)}
      onRefreshUrl={() => void urlQuery.refetch()}
    />
  ) : (
    <ObjectPreview state="loading" kind={kind} />
  );
}
