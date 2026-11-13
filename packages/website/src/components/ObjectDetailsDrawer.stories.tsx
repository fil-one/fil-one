import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
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

import { ObjectDetailsDrawer, type ObjectDrawerSiblings } from './ObjectDetailsDrawer';
import { queryKeys } from '../lib/query-client.js';

const BUCKET = 'any-bucket';
const REGION = S3Region.UsEast1;

// A stand-in image, inline so the story needs no network
const SAMPLE_IMAGE = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c7d2fe"/><stop offset="1" stop-color="#1e3a8a"/></linearGradient></defs><rect width="1200" height="800" fill="url(#g)"/><circle cx="820" cy="300" r="140" fill="#e0e7ff" opacity=".8"/></svg>',
)}`;

type Scenario = {
  objectKey: string;
  versionId?: string;
  metadata?: Partial<ObjectMetadataResponse>;
  previewUrl?: string;
  previewText?: { text: string; truncated: boolean };
  versioningEnabled?: boolean;
  objectLockEnabled?: boolean;
  siblings?: ObjectDrawerSiblings;
  /**
   * Leaves the object's details unseeded and stubs `fetch` while the story is
   * mounted: `loading` never answers, so the panel shows what the listing knows.
   */
  network?: 'loading';
};

const SIBLINGS: ObjectDrawerSiblings = {
  position: 4,
  total: 12,
  onPrevious: () => {},
  onNext: () => {},
};

function listedVersion(scenario: Scenario): S3ObjectVersion {
  return {
    key: scenario.objectKey,
    versionId: scenario.versionId ?? '3f9a1c7e5b2d4f60',
    sizeBytes: scenario.metadata?.sizeBytes ?? 2_097_152,
    lastModified: '2026-10-21T14:32:00Z',
    etag: '"1de267f54f14b8690462c8a1b8ffa208"',
    isLatest: !scenario.versionId,
    isDeleteMarker: false,
  };
}

function useStubbedFetch(network: Scenario['network']) {
  const [restore] = useState(() => {
    if (!network) return undefined;
    const realFetch = window.fetch;
    window.fetch = () => new Promise<Response>(() => {});
    return () => {
      window.fetch = realFetch;
    };
  });
  useEffect(() => restore, [restore]);
}

/** Seeds the queries the panel reads, marked fresh so nothing refetches. */
function Seeded({ scenario, children }: { scenario: Scenario; children: React.ReactNode }) {
  const client = useQueryClient();
  useStubbedFetch(scenario.network);
  useState(() => {
    const { objectKey, versionId } = scenario;
    const metadataKey = queryKeys.objectMetadata(BUCKET, objectKey, versionId);
    const previewKey = queryKeys.objectPreviewUrl(BUCKET, objectKey, versionId);
    for (const key of [metadataKey, previewKey]) {
      client.setQueryDefaults(key, { staleTime: Infinity });
    }
    if (!scenario.network) {
      client.setQueryData(metadataKey, {
        key: objectKey,
        sizeBytes: 2_097_152,
        lastModified: '2026-10-21T14:32:00Z',
        etag: '"1de267f54f14b8690462c8a1b8ffa208"',
        contentType: 'image/png',
        metadata: {},
        ...scenario.metadata,
      } satisfies ObjectMetadataResponse);
    }
    if (scenario.previewUrl) client.setQueryData(previewKey, scenario.previewUrl);
    if (scenario.previewText) client.setQueryData([...previewKey, 'text'], scenario.previewText);
    return null;
  });
  return <>{children}</>;
}

function renderDrawer(scenario: Scenario) {
  const rootRoute = createRootRoute();
  const bucketRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/buckets/$bucketName',
    component: () => (
      <ObjectDetailsDrawer
        bucketName={BUCKET}
        region={REGION}
        objectKey={scenario.objectKey}
        versionId={scenario.versionId}
        listed={listedVersion(scenario)}
        versioningEnabled={scenario.versioningEnabled ?? false}
        objectLockEnabled={scenario.objectLockEnabled ?? false}
        siblings={scenario.siblings}
        onDownload={() => {}}
        onDelete={() => Promise.resolve()}
        onClose={() => {}}
      />
    ),
  });
  const objectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/buckets/$bucketName/objects',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([bucketRoute, objectRoute]),
    history: createMemoryHistory({ initialEntries: [`/buckets/${BUCKET}`] }),
  });
  return (
    <Seeded scenario={scenario}>
      <RouterProvider router={router} />
    </Seeded>
  );
}

const meta: Meta = {
  title: 'Components/ObjectDetailsDrawer',
  // A paid plan, so Share is enabled as it is for most callers
  parameters: { layout: 'fullscreen', billingStatus: SubscriptionStatus.Active },
};

export default meta;
type Story = StoryObj;

export const Image: Story = {
  render: () =>
    renderDrawer({
      objectKey:
        'spacepunkbg/a_brilliant_clean_bright_white_plastic_space_station_window_n_74ac044b-3881-4f6f-a4f1-68dc98a5500b_0.png',
      previewUrl: SAMPLE_IMAGE,
      siblings: SIBLINGS,
      metadata: { metadata: { tags: JSON.stringify(['backgrounds', 'space']) } },
    }),
};

export const LoadingDetails: Story = {
  render: () =>
    renderDrawer({
      objectKey: 'any-folder/any-photo.png',
      network: 'loading',
      objectLockEnabled: true,
      siblings: SIBLINGS,
    }),
};

export const Text: Story = {
  render: () =>
    renderDrawer({
      objectKey: 'any-folder/config.json',
      metadata: { contentType: 'application/json', sizeBytes: 412 },
      previewUrl: 'about:blank',
      previewText: {
        text: JSON.stringify({ name: 'any-service', replicas: 3, regions: ['us-east-1'] }, null, 2),
        truncated: false,
      },
      siblings: { ...SIBLINGS, position: 1, onPrevious: undefined },
    }),
};

export const OlderVersionWithRetention: Story = {
  render: () =>
    renderDrawer({
      objectKey: 'any-folder/any-ledger.csv',
      versionId: '8b2e6d40c19a7f35',
      versioningEnabled: true,
      objectLockEnabled: true,
      metadata: {
        contentType: 'text/csv',
        sizeBytes: 2_400_000,
        retention: { mode: 'COMPLIANCE', retainUntilDate: '2027-10-21T00:00:00Z' },
      },
    }),
};

export const LapsedRetention: Story = {
  render: () =>
    renderDrawer({
      objectKey: 'fil-one-logo.png',
      objectLockEnabled: true,
      versioningEnabled: true,
      previewUrl: SAMPLE_IMAGE,
      metadata: {
        sizeBytes: 72_200,
        retention: { mode: 'COMPLIANCE', retainUntilDate: '2026-05-02T00:00:00Z' },
      },
      siblings: SIBLINGS,
    }),
};

export const UnsupportedType: Story = {
  render: () =>
    renderDrawer({
      objectKey: 'any-archive.zip',
      metadata: { contentType: 'application/zip', sizeBytes: 48_000_000 },
      siblings: { ...SIBLINGS, position: 12, onNext: undefined },
    }),
};
