import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

import type { S3ObjectVersion } from '@filone/shared';

import { VersionHistoryCard, VersionRowBadge } from './VersionHistoryCard';

const multipleVersions: S3ObjectVersion[] = [
  {
    key: 'report.pdf',
    sizeBytes: 524_288,
    lastModified: '2026-04-18T10:00:00Z',
    versionId: '9a87b3cfd214e6',
    isLatest: true,
    isDeleteMarker: false,
  },
  {
    key: 'report.pdf',
    sizeBytes: 498_112,
    lastModified: '2026-04-15T09:00:00Z',
    versionId: '4c12ef9a7b61d0',
    isLatest: false,
    isDeleteMarker: false,
  },
  {
    key: 'report.pdf',
    sizeBytes: 450_000,
    lastModified: '2026-04-10T08:00:00Z',
    versionId: 'a01d55f8c2e943',
    isLatest: false,
    isDeleteMarker: false,
  },
];

const withDeleteMarker: S3ObjectVersion[] = [
  {
    key: 'secrets.env',
    sizeBytes: 0,
    lastModified: '2026-04-17T12:00:00Z',
    versionId: 'dm-aa11bb22cc33',
    isLatest: true,
    isDeleteMarker: true,
  },
  {
    key: 'secrets.env',
    sizeBytes: 2048,
    lastModified: '2026-04-15T10:00:00Z',
    versionId: 'v-bb22cc33dd44',
    isLatest: false,
    isDeleteMarker: false,
  },
];

const withRouter = (Story: React.ComponentType) => {
  const rootRoute = createRootRoute({ component: () => <Story /> });
  const objectsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/buckets/$bucketName/objects',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([objectsRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return <RouterProvider router={router} />;
};

// ---------------------------------------------------------------------------
// VersionHistoryCard
// ---------------------------------------------------------------------------

const meta: Meta<typeof VersionHistoryCard> = {
  title: 'Components/VersionHistoryCard',
  component: VersionHistoryCard,
  decorators: [withRouter],
};

export default meta;
type Story = StoryObj<typeof VersionHistoryCard>;

export const MultipleVersions: Story = {
  render: () => (
    <VersionHistoryCard
      bucketName="my-bucket"
      versions={multipleVersions}
      currentVersionId={multipleVersions[0].versionId}
    />
  ),
};

export const ViewingHistoricalVersion: Story = {
  render: () => (
    <VersionHistoryCard
      bucketName="my-bucket"
      versions={multipleVersions}
      currentVersionId={multipleVersions[1].versionId}
    />
  ),
};

export const WithDeleteMarker: Story = {
  render: () => (
    <VersionHistoryCard
      bucketName="my-bucket"
      versions={withDeleteMarker}
      currentVersionId={withDeleteMarker[0].versionId}
    />
  ),
};

export const SingleVersionRendersNothing: Story = {
  render: () => (
    <div>
      <p className="mb-2 text-xs text-zinc-500">
        Card is not rendered when there is only one version.
      </p>
      <VersionHistoryCard
        bucketName="my-bucket"
        versions={[multipleVersions[0]]}
        currentVersionId={multipleVersions[0].versionId}
      />
    </div>
  ),
};

// ---------------------------------------------------------------------------
// VersionRowBadge (row context)
// ---------------------------------------------------------------------------

export const RowBadgeVariants: StoryObj = {
  name: 'VersionRowBadge / All variants',
  render: () => (
    <div className="flex flex-col items-start gap-3">
      <VersionRowBadge version={multipleVersions[0]} />
      <VersionRowBadge version={withDeleteMarker[0]} />
      <div>
        <span className="mr-2 text-xs text-zinc-500">Historical (renders nothing):</span>
        <VersionRowBadge version={multipleVersions[1]} />
      </div>
    </div>
  ),
};
