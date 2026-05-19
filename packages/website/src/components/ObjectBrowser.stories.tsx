import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

import type { S3ObjectVersion } from '@filone/shared';

import { ObjectBrowser, type ObjectBrowserProps } from './ObjectBrowser';

const sampleVersions: S3ObjectVersion[] = [
  {
    key: 'README.md',
    sizeBytes: 2048,
    lastModified: '2026-04-15T10:00:00Z',
    versionId: 'v-readme-1',
    isLatest: true,
    isDeleteMarker: false,
  },
  {
    key: 'logo.png',
    sizeBytes: 154_321,
    lastModified: '2026-04-12T09:20:00Z',
    versionId: 'v-logo-1',
    isLatest: true,
    isDeleteMarker: false,
  },
  {
    key: 'images/hero.jpg',
    sizeBytes: 842_112,
    lastModified: '2026-04-10T11:45:00Z',
    versionId: 'v-hero-1',
    isLatest: true,
    isDeleteMarker: false,
  },
  {
    key: 'images/thumbnails/small.jpg',
    sizeBytes: 12_345,
    lastModified: '2026-04-10T11:50:00Z',
    versionId: 'v-small-1',
    isLatest: true,
    isDeleteMarker: false,
  },
  {
    key: 'docs/intro.md',
    sizeBytes: 5_120,
    lastModified: '2026-04-08T08:05:00Z',
    versionId: 'v-intro-1',
    isLatest: true,
    isDeleteMarker: false,
  },
  {
    key: 'docs/guide.md',
    sizeBytes: 22_400,
    lastModified: '2026-04-09T14:30:00Z',
    versionId: 'v-guide-1',
    isLatest: true,
    isDeleteMarker: false,
  },
  {
    key: 'archive.zip',
    sizeBytes: 10_485_760,
    lastModified: '2026-03-30T16:12:00Z',
    versionId: 'v-archive-1',
    isLatest: true,
    isDeleteMarker: false,
  },
];

const multiVersionVersions: S3ObjectVersion[] = [
  {
    key: 'report.pdf',
    sizeBytes: 524_288,
    lastModified: '2026-04-18T10:00:00Z',
    versionId: 'v-report-3',
    isLatest: true,
    isDeleteMarker: false,
  },
  {
    key: 'report.pdf',
    sizeBytes: 498_112,
    lastModified: '2026-04-15T09:00:00Z',
    versionId: 'v-report-2',
    isLatest: false,
    isDeleteMarker: false,
  },
  {
    key: 'report.pdf',
    sizeBytes: 450_000,
    lastModified: '2026-04-10T08:00:00Z',
    versionId: 'v-report-1',
    isLatest: false,
    isDeleteMarker: false,
  },
  {
    key: 'removed.txt',
    sizeBytes: 0,
    lastModified: '2026-04-17T12:00:00Z',
    versionId: 'v-removed-dm',
    isLatest: true,
    isDeleteMarker: true,
  },
  {
    key: 'removed.txt',
    sizeBytes: 1024,
    lastModified: '2026-04-12T11:00:00Z',
    versionId: 'v-removed-1',
    isLatest: false,
    isDeleteMarker: false,
  },
];

function ObjectBrowserHarness(
  initial: Omit<ObjectBrowserProps, 'onPrefixChange' | 'onDelete' | 'versioningEnabled'> & {
    versioningEnabled?: boolean;
  },
) {
  const [prefix, setPrefix] = useState(initial.currentPrefix);
  return (
    <ObjectBrowser
      {...initial}
      versioningEnabled={initial.versioningEnabled ?? true}
      currentPrefix={prefix}
      onPrefixChange={setPrefix}
      onDelete={() => Promise.resolve()}
    />
  );
}

const withRouter = (Story: React.ComponentType) => {
  const rootRoute = createRootRoute({ component: () => <Story /> });
  const uploadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/buckets/$bucketName/upload',
    component: () => null,
  });
  const objectsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/buckets/$bucketName/objects',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([uploadRoute, objectsRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return <RouterProvider router={router} />;
};

const meta: Meta<typeof ObjectBrowser> = {
  title: 'Components/ObjectBrowser',
  component: ObjectBrowser,
  decorators: [withRouter],
};

export default meta;
type Story = StoryObj<typeof ObjectBrowser>;

export const Empty: Story = {
  render: () => (
    <ObjectBrowserHarness
      bucketName="my-bucket"
      versions={[]}
      currentPrefix=""
      onDownload={() => {}}
      downloading={null}
    />
  ),
};

export const RootListing: Story = {
  render: () => (
    <ObjectBrowserHarness
      bucketName="my-bucket"
      versions={sampleVersions}
      currentPrefix=""
      onDownload={() => {}}
      downloading={null}
    />
  ),
};

export const InsideFolder: Story = {
  render: () => (
    <ObjectBrowserHarness
      bucketName="my-bucket"
      versions={sampleVersions}
      currentPrefix="images/"
      onDownload={() => {}}
      downloading={null}
    />
  ),
};

export const NestedFolder: Story = {
  render: () => (
    <ObjectBrowserHarness
      bucketName="my-bucket"
      versions={sampleVersions}
      currentPrefix="images/thumbnails/"
      onDownload={() => {}}
      downloading={null}
    />
  ),
};

export const EmptyFolderPath: Story = {
  render: () => (
    <ObjectBrowserHarness
      bucketName="my-bucket"
      versions={sampleVersions}
      currentPrefix="missing/"
      onDownload={() => {}}
      downloading={null}
    />
  ),
};

export const Downloading: Story = {
  render: () => (
    <ObjectBrowserHarness
      bucketName="my-bucket"
      versions={sampleVersions}
      currentPrefix=""
      onDownload={() => {}}
      downloading="archive.zip"
    />
  ),
};

export const MultipleVersions: Story = {
  render: () => (
    <ObjectBrowserHarness
      bucketName="my-bucket"
      versions={multiVersionVersions}
      currentPrefix=""
      onDownload={() => {}}
      downloading={null}
    />
  ),
};

export const VersioningDisabled: Story = {
  render: () => (
    <ObjectBrowserHarness
      bucketName="my-bucket"
      versions={sampleVersions}
      versioningEnabled={false}
      currentPrefix=""
      onDownload={() => {}}
      downloading={null}
    />
  ),
};

export const DeleteMarker: Story = {
  render: () => (
    <ObjectBrowserHarness
      bucketName="my-bucket"
      versions={[
        {
          key: 'deleted-file.log',
          sizeBytes: 0,
          lastModified: '2026-04-19T09:00:00Z',
          versionId: 'v-dm-1',
          isLatest: true,
          isDeleteMarker: true,
        },
      ]}
      currentPrefix=""
      onDownload={() => {}}
      downloading={null}
    />
  ),
};
