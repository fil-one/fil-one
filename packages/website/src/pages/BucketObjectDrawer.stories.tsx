import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

import { S3Region, SubscriptionStatus } from '@filone/shared';
import type { ObjectMetadataResponse, S3ObjectVersion } from '@filone/shared';

import { BucketObjectDrawer, useObjectDrawerNavigation } from './BucketObjectDrawer';
import { queryKeys } from '../lib/query-client.js';

const BUCKET = 'any-bucket';
const REGION = S3Region.UsEast1;
const FOLDER = 'any-folder/';

// A stand-in image, inline so the story needs no network
const SAMPLE_IMAGE = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c7d2fe"/><stop offset="1" stop-color="#1e3a8a"/></linearGradient></defs><rect width="1200" height="800" fill="url(#g)"/><circle cx="820" cy="300" r="140" fill="#e0e7ff" opacity=".8"/></svg>',
)}`;

/** One object in the open folder, with what its details and preview answer. */
type FolderObject = {
  key: string;
  contentType: string;
  sizeBytes: number;
  previewUrl?: string;
  previewText?: string;
};

// The open folder, in the table's order (by name). Stepping walks these and passes
// over the subfolder, which `VERSIONS` lists too.
const FOLDER_OBJECTS: FolderObject[] = [
  { key: `${FOLDER}any-archive.zip`, contentType: 'application/zip', sizeBytes: 48_000_000 },
  {
    key: `${FOLDER}any-config.json`,
    contentType: 'application/json',
    sizeBytes: 412,
    previewText: JSON.stringify({ name: 'any-service', replicas: 3 }, null, 2),
  },
  {
    key: `${FOLDER}any-cover.png`,
    contentType: 'image/png',
    sizeBytes: 72_200,
    previewUrl: SAMPLE_IMAGE,
  },
  {
    key: `${FOLDER}any-photo.png`,
    contentType: 'image/png',
    sizeBytes: 2_097_152,
    previewUrl: SAMPLE_IMAGE,
  },
];

// Opened by a link from elsewhere, so the open folder does not list it
const OUTSIDE_OBJECT: FolderObject = {
  key: 'any-other-folder/any-file.png',
  contentType: 'image/png',
  sizeBytes: 72_200,
  previewUrl: SAMPLE_IMAGE,
};

const ETAG = '"1de267f54f14b8690462c8a1b8ffa208"';

const VERSIONS: S3ObjectVersion[] = [
  ...FOLDER_OBJECTS.map(({ key, sizeBytes }) => ({
    key,
    versionId: '',
    sizeBytes,
    lastModified: '2026-10-21T14:32:00Z',
    etag: ETAG,
    isLatest: true,
    isDeleteMarker: false,
  })),
  {
    key: `${FOLDER}any-subfolder/any-file.bin`,
    versionId: '',
    sizeBytes: 1024,
    lastModified: '2026-10-21T14:32:00Z',
    isLatest: true,
    isDeleteMarker: false,
  },
];

/** Seeds every object's details and preview, marked fresh so nothing refetches. */
function Seeded({ children }: { children: React.ReactNode }) {
  const client = useQueryClient();
  useState(() => {
    for (const object of [...FOLDER_OBJECTS, OUTSIDE_OBJECT]) {
      const metadataKey = queryKeys.objectMetadata(BUCKET, object.key);
      const previewKey = queryKeys.objectPreviewUrl(BUCKET, object.key);
      for (const key of [metadataKey, previewKey]) {
        client.setQueryDefaults(key, { staleTime: Infinity });
      }
      client.setQueryData(metadataKey, {
        key: object.key,
        sizeBytes: object.sizeBytes,
        lastModified: '2026-10-21T14:32:00Z',
        etag: ETAG,
        contentType: object.contentType,
        metadata: {},
      } satisfies ObjectMetadataResponse);
      if (object.previewUrl) client.setQueryData(previewKey, object.previewUrl);
      if (object.previewText) {
        client.setQueryData([...previewKey, 'text', ETAG], {
          text: object.previewText,
          truncated: false,
        });
      }
    }
    return null;
  });
  return <>{children}</>;
}

/** The URL's say over the panel, as the bucket page reads it. */
type DrawerSearch = { object?: string; version?: string };

function DrawerFromUrl({ search }: { search: DrawerSearch }) {
  const navigation = useObjectDrawerNavigation(BUCKET, REGION, FOLDER);
  if (!search.object) {
    return (
      <p className="p-8 text-ui text-zinc-500">The panel closed. Reload the story to open it.</p>
    );
  }
  return (
    <BucketObjectDrawer
      bucketName={BUCKET}
      region={REGION}
      versions={VERSIONS}
      currentPrefix={FOLDER}
      openObject={{ key: search.object, versionId: search.version }}
      versioningEnabled={false}
      objectLockEnabled={false}
      onDownload={() => {}}
      onDeleted={() => {}}
      navigation={navigation}
    />
  );
}

/** The panel under a router of its own, so stepping moves through the folder for real. */
function renderDrawer(objectKey: string) {
  const rootRoute = createRootRoute();
  const bucketRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/buckets/$bucketName',
    validateSearch: (search: Record<string, unknown>): DrawerSearch => ({
      object: typeof search.object === 'string' ? search.object : undefined,
      version: typeof search.version === 'string' ? search.version : undefined,
    }),
    component: function BucketRoute() {
      return <DrawerFromUrl search={bucketRoute.useSearch()} />;
    },
  });
  const objectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/buckets/$bucketName/objects',
    component: () => null,
  });
  const search = new URLSearchParams({ region: REGION, prefix: FOLDER, object: objectKey });
  const router = createRouter({
    routeTree: rootRoute.addChildren([bucketRoute, objectRoute]),
    history: createMemoryHistory({ initialEntries: [`/buckets/${BUCKET}?${search}`] }),
  });
  return (
    <Seeded>
      <RouterProvider router={router} />
    </Seeded>
  );
}

const meta: Meta = {
  title: 'Pages/BucketObjectDrawer',
  // A paid plan, so Share is enabled as it is for most callers
  parameters: { layout: 'fullscreen', billingStatus: SubscriptionStatus.Active },
};

export default meta;
type Story = StoryObj;

/** Mid-folder: both arrows step, through an image, a text file and a type with no preview. */
export const MidFolder: Story = {
  render: () => renderDrawer(FOLDER_OBJECTS[1].key),
};

export const FirstInFolder: Story = {
  render: () => renderDrawer(FOLDER_OBJECTS[0].key),
};

export const LastInFolder: Story = {
  render: () => renderDrawer(FOLDER_OBJECTS[3].key),
};

/**
 * An object the open folder does not list, as a link to one in another folder
 * gives. There is nothing to step to, so the panel has no position or arrows.
 */
export const NotInFolder: Story = {
  render: () => renderDrawer(OUTSIDE_OBJECT.key),
};
