import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

import type { S3Object } from '@filone/shared';

import { ObjectBrowser, type ObjectBrowserProps } from './ObjectBrowser';

const sampleObjects: S3Object[] = [
  {
    key: 'README.md',
    sizeBytes: 2048,
    lastModified: '2026-04-15T10:00:00Z',
  },
  {
    key: 'logo.png',
    sizeBytes: 154_321,
    lastModified: '2026-04-12T09:20:00Z',
  },
  {
    key: 'images/hero.jpg',
    sizeBytes: 842_112,
    lastModified: '2026-04-10T11:45:00Z',
  },
  {
    key: 'images/thumbnails/small.jpg',
    sizeBytes: 12_345,
    lastModified: '2026-04-10T11:50:00Z',
  },
  {
    key: 'docs/intro.md',
    sizeBytes: 5_120,
    lastModified: '2026-04-08T08:05:00Z',
  },
  {
    key: 'docs/guide.md',
    sizeBytes: 22_400,
    lastModified: '2026-04-09T14:30:00Z',
  },
  {
    key: 'archive.zip',
    sizeBytes: 10_485_760,
    lastModified: '2026-03-30T16:12:00Z',
  },
];

function ObjectBrowserHarness(initial: Omit<ObjectBrowserProps, 'onPrefixChange' | 'onDelete'>) {
  const [prefix, setPrefix] = useState(initial.currentPrefix);
  return (
    <ObjectBrowser
      {...initial}
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
      objects={[]}
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
      objects={sampleObjects}
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
      objects={sampleObjects}
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
      objects={sampleObjects}
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
      objects={sampleObjects}
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
      objects={sampleObjects}
      currentPrefix=""
      onDownload={() => {}}
      downloading="archive.zip"
    />
  ),
};
