import type { Meta, StoryObj } from '@storybook/react-vite';

import type { AccessKey } from '@filone/shared';

import { BucketAccessTab } from './BucketAccessTab';

const mockKeys: AccessKey[] = [
  {
    id: '1',
    keyName: 'Production API Key',
    accessKeyId: 'ACCESS_KEY_12345EXAMPL',
    createdAt: '2026-01-15T10:00:00Z',
    lastUsedAt: '2026-04-08T14:30:00Z',
    status: 'active',
    permissions: ['read', 'write', 'list'],
    bucketScope: 'specific',
    buckets: ['my-bucket'],
  },
  {
    id: '2',
    keyName: 'Read-Only Backup',
    accessKeyId: 'ACCESS_KEY_09876EXAMPL',
    createdAt: '2026-02-20T08:00:00Z',
    status: 'active',
    permissions: ['read', 'list'],
    bucketScope: 'specific',
    buckets: ['my-bucket'],
  },
];

const meta: Meta<typeof BucketAccessTab> = {
  title: 'Components/BucketAccessTab',
  component: BucketAccessTab,
  args: {
    bucketName: 'my-bucket',
    s3Endpoint: 'https://s3.filone.org',
    region: 'us-east-1',
    onCreateOpen: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof BucketAccessTab>;

export const WithKeys: Story = {
  args: {
    accessKeys: mockKeys,
    accessKeysLoading: false,
  },
};

export const Empty: Story = {
  args: {
    accessKeys: [],
    accessKeysLoading: false,
  },
};

export const Loading: Story = {
  args: {
    accessKeys: [],
    accessKeysLoading: true,
  },
};
