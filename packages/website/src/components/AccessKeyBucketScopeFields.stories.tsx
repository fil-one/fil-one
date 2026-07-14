import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { S3Region, type AccessKeyBucketScope, type ListBucketsResponse } from '@filone/shared';

import { queryKeys } from '../lib/query-client';
import { AccessKeyBucketScopeFields } from './AccessKeyBucketScopeFields';

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
    { bucketName: 'media', region: 'eu-west-1', createdAt: '2026-03-01T00:00:00Z', isPublic: true },
  ],
};

function createSeededQueryClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(queryKeys.buckets, mockBuckets);
  return client;
}

const meta: Meta<typeof AccessKeyBucketScopeFields> = {
  title: 'Components/AccessKeyBucketScopeFields',
  component: AccessKeyBucketScopeFields,
};

export default meta;
type Story = StoryObj<typeof AccessKeyBucketScopeFields>;

export const AllBuckets: Story = {
  args: {
    bucketScope: 'all',
    selectedBuckets: [],
  },
};

export const Interactive: Story = {
  render: () => {
    const [queryClient] = useState(createSeededQueryClient);
    const [bucketScope, setBucketScope] = useState<AccessKeyBucketScope>('all');
    const [selectedBuckets, setSelectedBuckets] = useState<string[]>([]);
    return (
      <QueryClientProvider client={queryClient}>
        <AccessKeyBucketScopeFields
          region={S3Region.UsEast1}
          bucketScope={bucketScope}
          onBucketScopeChange={setBucketScope}
          selectedBuckets={selectedBuckets}
          onSelectedBucketsChange={setSelectedBuckets}
        />
      </QueryClientProvider>
    );
  },
};
