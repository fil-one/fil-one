import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';
import { useQueryClient } from '@tanstack/react-query';
import { expect, screen } from 'storybook/test';

import type { ListBucketsResponse } from '@filone/shared';
import { S3Region } from '@filone/shared';

import { queryKeys } from '../lib/query-client';
import { Button } from './Button';
import { AddBucketKeyModal } from './AddBucketKeyModal';

const mockBuckets: ListBucketsResponse = {
  buckets: [
    {
      bucketName: 'my-bucket',
      region: 'us-east-1',
      createdAt: '2026-01-15T00:00:00Z',
      isPublic: false,
    },
    {
      bucketName: 'backups',
      region: 'us-east-1',
      createdAt: '2026-02-20T00:00:00Z',
      isPublic: false,
    },
  ],
};

// The buckets go into the preview's client, which already holds the story's
// role; a client of its own would lose it. Seeded before the first render and
// never stale, since no server answers a refetch.
function AddBucketKeyModalStory({ region }: { region: S3Region }) {
  const [open, setOpen] = useState(true);
  const queryClient = useQueryClient();
  useState(() => {
    queryClient.setQueryDefaults(queryKeys.buckets, { staleTime: Infinity });
    queryClient.setQueryData(queryKeys.buckets, mockBuckets);
  });
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        Add bucket key
      </Button>
      <AddBucketKeyModal
        open={open}
        onClose={() => setOpen(false)}
        bucketName="my-bucket"
        region={region}
        onKeyAdded={() => {}}
      />
    </>
  );
}

const meta: Meta<typeof AddBucketKeyModal> = {
  title: 'Components/AddBucketKeyModal',
  component: AddBucketKeyModal,
};

export default meta;
type Story = StoryObj<typeof AddBucketKeyModal>;

export const Default: Story = {
  render: () => <AddBucketKeyModalStory region={S3Region.UsEast1} />,
};

export const OnIamRegion: Story = {
  render: () => <AddBucketKeyModalStory region={S3Region.UsEast9} />,
  // The modal renders in a portal outside the story's canvas.
  play: async () => {
    await expect(await screen.findByText('Follows the bucket policies')).toBeVisible();
  },
};
