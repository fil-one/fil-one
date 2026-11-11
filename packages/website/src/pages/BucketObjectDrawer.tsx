import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useRouter } from '@tanstack/react-router';

import type { S3ObjectVersion, S3Region } from '@filone/shared';

import { ObjectDetailsDrawer, type ObjectDrawerSiblings } from '../components/ObjectDetailsDrawer';
import { getEntriesAtPrefix, groupVersionsByKey } from '../lib/object-grouping.js';
import type { VersionGroup } from '../lib/object-grouping.js';
import { prefetchObjectMetadata } from '../lib/object-metadata.js';
import { useObjectActions } from '../lib/use-object-actions.js';

/** The object open in the details panel. No version means the object itself, its latest. */
export type OpenObject = { key: string; versionId?: string };

// How long the pointer rests on a row before its details start loading. Long
// enough that sweeping across the table fetches nothing, short enough that the
// details are usually in by the time the click lands.
const HOVER_INTENT_MS = 100;

/**
 * Opening, stepping and closing the panel, all through the URL. Opening adds a
 * history entry, so back closes the panel; stepping replaces it, so back still
 * returns to the list rather than walking through every object seen.
 */
export function useObjectDrawerNavigation(
  bucketName: string,
  region: S3Region,
  currentPrefix: string,
) {
  const navigate = useNavigate();
  const router = useRouter();
  // Whether the panel was opened from the list in this visit. Closing it then
  // goes back, so the entry opening it added does not linger. A panel that came
  // in with the page (a reload, a link) has no such entry, and closing it
  // replaces the URL instead.
  const openedFromList = useRef(false);

  const go = useCallback(
    (object: OpenObject | undefined, replace: boolean) =>
      void navigate({
        to: '/buckets/$bucketName',
        params: { bucketName },
        search: {
          region,
          ...(currentPrefix && { prefix: currentPrefix }),
          ...(object && {
            object: object.key,
            ...(object.versionId && { version: object.versionId }),
          }),
        },
        replace,
      }),
    [navigate, bucketName, region, currentPrefix],
  );

  return {
    open: useCallback(
      (object: OpenObject) => {
        openedFromList.current = true;
        go(object, false);
      },
      [go],
    ),
    step: useCallback((object: OpenObject) => go(object, true), [go]),
    close: useCallback(() => {
      if (openedFromList.current) {
        openedFromList.current = false;
        router.history.back();
      } else {
        go(undefined, true);
      }
    }, [go, router]),
  };
}

/** Starts loading a row's details once the pointer rests on it. */
export function useObjectHoverPrefetch(bucketName: string, region: S3Region) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cancel = useCallback(() => clearTimeout(timer.current), []);
  useEffect(() => cancel, [cancel]);
  const hover = useCallback(
    (object: OpenObject) => {
      cancel();
      timer.current = setTimeout(
        () =>
          prefetchObjectMetadata({
            bucketName,
            region,
            objectKey: object.key,
            versionId: object.versionId,
          }),
        HOVER_INTENT_MS,
      );
    },
    [bucketName, region, cancel],
  );
  return { hover, cancel };
}

/**
 * A row's object and version, as the panel names them. The listing gives every row
 * a version ID: '' in a bucket without versioning, and the latest's own ID on an
 * object's main row. Both mean the object itself, so neither goes in the URL.
 */
export function toOpenObject(
  versions: S3ObjectVersion[],
  key: string,
  versionId: string,
): OpenObject {
  if (!versionId) return { key };
  const latest = versions.find((v) => v.key === key && v.isLatest);
  return latest?.versionId === versionId ? { key } : { key, versionId };
}

/** The objects in the open folder, in the table's order, without its folders. */
function getFolderObjects(versions: S3ObjectVersion[], prefix: string): VersionGroup[] {
  return getEntriesAtPrefix(groupVersionsByKey(versions), prefix).flatMap((entry) =>
    entry.kind === 'object' ? [entry.group] : [],
  );
}

// Unlike `at`, a position before the start is nothing rather than the last item
function getAt<T>(items: T[], position: number): T | undefined {
  return position >= 0 && position < items.length ? items[position] : undefined;
}

export type BucketObjectDrawerProps = {
  bucketName: string;
  region: S3Region;
  versions: S3ObjectVersion[];
  currentPrefix: string;
  openObject: OpenObject;
  versioningEnabled: boolean;
  objectLockEnabled: boolean;
  onDownload: (key: string, versionId?: string) => void;
  onDeleted: (key: string, versionId?: string) => void;
  navigation: ReturnType<typeof useObjectDrawerNavigation>;
};

/**
 * The details panel over the Objects tab, for the object named in the URL. Up and
 * down step through the open folder's objects in the table's order, and the
 * neighbours' details load ahead so stepping does not wait.
 */
export function BucketObjectDrawer({
  bucketName,
  region,
  versions,
  currentPrefix,
  openObject,
  versioningEnabled,
  objectLockEnabled,
  onDownload,
  onDeleted,
  navigation,
}: BucketObjectDrawerProps) {
  const { key, versionId } = openObject;
  const folderObjects = useMemo(
    () => getFolderObjects(versions, currentPrefix),
    [versions, currentPrefix],
  );
  const index = folderObjects.findIndex((group) => group.key === key);
  const group = getAt(folderObjects, index);
  const listed = versionId ? group?.versions.find((v) => v.versionId === versionId) : group?.latest;
  const previous = index === -1 ? undefined : getAt(folderObjects, index - 1);
  const next = index === -1 ? undefined : getAt(folderObjects, index + 1);

  useEffect(() => {
    for (const neighbour of [previous, next]) {
      if (neighbour) prefetchObjectMetadata({ bucketName, region, objectKey: neighbour.key });
    }
  }, [bucketName, region, previous, next]);

  const objectActions = useObjectActions({
    bucketName,
    region,
    onDeleted: (deletedKey, deletedVersionId) => {
      onDeleted(deletedKey, deletedVersionId);
      navigation.close();
    },
  });

  const siblings: ObjectDrawerSiblings | undefined =
    index === -1
      ? undefined
      : {
          position: index + 1,
          total: folderObjects.length,
          onPrevious: previous && (() => navigation.step({ key: previous.key })),
          onNext: next && (() => navigation.step({ key: next.key })),
        };

  return (
    <ObjectDetailsDrawer
      bucketName={bucketName}
      region={region}
      objectKey={key}
      versionId={versionId}
      listed={listed}
      versioningEnabled={versioningEnabled}
      objectLockEnabled={objectLockEnabled}
      siblings={siblings}
      onDownload={() => onDownload(key, versionId)}
      onDelete={() => objectActions.deleteObject(key, versionId)}
      onClose={navigation.close}
    />
  );
}

/**
 * Everything the Objects tab needs for the panel: what the object table calls on
 * a row's click and hover, and the panel itself when the URL names an object.
 */
export function useBucketObjectDrawer({
  bucketName,
  region,
  versions,
  currentPrefix,
  openObject,
  versioningEnabled,
  objectLockEnabled,
  onDownload,
  onDeleted,
}: {
  bucketName: string;
  region: S3Region;
  versions: S3ObjectVersion[];
  currentPrefix: string;
  openObject?: OpenObject;
  versioningEnabled: boolean;
  objectLockEnabled: boolean;
  onDownload: (key: string, versionId?: string) => void;
  onDeleted: (key: string, versionId?: string) => void;
}) {
  const navigation = useObjectDrawerNavigation(bucketName, region, currentPrefix);
  const hoverPrefetch = useObjectHoverPrefetch(bucketName, region);

  return {
    browserProps: {
      onOpenObject: (key: string, versionId: string) =>
        navigation.open(toOpenObject(versions, key, versionId)),
      onHoverObject: (key: string, versionId: string) =>
        hoverPrefetch.hover(toOpenObject(versions, key, versionId)),
      onHoverObjectEnd: hoverPrefetch.cancel,
    },
    drawer: openObject && (
      <BucketObjectDrawer
        bucketName={bucketName}
        region={region}
        versions={versions}
        currentPrefix={currentPrefix}
        openObject={openObject}
        versioningEnabled={versioningEnabled}
        objectLockEnabled={objectLockEnabled}
        onDownload={onDownload}
        onDeleted={onDeleted}
        navigation={navigation}
      />
    ),
  };
}
