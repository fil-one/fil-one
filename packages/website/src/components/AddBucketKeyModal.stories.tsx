import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { ListBucketsResponse } from '@filone/shared';

import { queryKeys } from '../lib/query-client';
import { Button } from './Button';
import { AddBucketKeyModal } from './AddBucketKeyModal';

const mockBuckets: ListBucketsResponse = {
  buckets: [
    { name: 'my-bucket', region: 'us-east-1', createdAt: '2026-01-15T00:00:00Z', isPublic: false },
    { name: 'backups', region: 'us-east-1', createdAt: '2026-02-20T00:00:00Z', isPublic: false },
  ],
};

function createSeededQueryClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(queryKeys.buckets, mockBuckets);
  return client;
}

const meta: Meta<typeof AddBucketKeyModal> = {
  title: 'Components/AddBucketKeyModal',
  component: AddBucketKeyModal,
};

export default meta;
type Story = StoryObj<typeof AddBucketKeyModal>;

export const Default: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    const [queryClient] = useState(createSeededQueryClient);
    return (
      <QueryClientProvider client={queryClient}>
        <Button variant="primary" onClick={() => setOpen(true)}>
          Add bucket key
        </Button>
        <AddBucketKeyModal
          open={open}
          onClose={() => setOpen(false)}
          bucketName="my-bucket"
          onKeyAdded={() => {}}
        />
      </QueryClientProvider>
    );
  },
};
