import type { Meta, StoryObj } from '@storybook/react-vite';

import type { AccessKey } from '@filone/shared';

import { AccessKeysTable } from './AccessKeysTable';

const meta: Meta<typeof AccessKeysTable> = {
  title: 'Components/AccessKeysTable',
  component: AccessKeysTable,
};

export default meta;
type Story = StoryObj<typeof AccessKeysTable>;

const mockKeys: AccessKey[] = [
  {
    id: '1',
    keyName: 'Production API Key',
    accessKeyId: 'ACCESS_KEY_12345EXAMPL',
    createdAt: '2026-01-15T10:00:00Z',
    lastUsedAt: '2026-04-08T14:30:00Z',
    status: 'active',
    permissions: ['read', 'write', 'list'],
    bucketScope: 'all',
  },
  {
    id: '2',
    keyName: 'Backup Read-Only',
    accessKeyId: 'ACCESS_KEY_09876EXAMPL',
    createdAt: '2026-02-20T08:00:00Z',
    status: 'active',
    permissions: ['read', 'list'],
    bucketScope: 'specific',
    buckets: ['backups', 'archives'],
  },
  {
    id: '3',
    keyName: 'Deprecated Key',
    accessKeyId: 'ACCESS_KEY_00000EXAMPL',
    createdAt: '2025-06-01T12:00:00Z',
    lastUsedAt: '2025-12-01T09:00:00Z',
    status: 'inactive',
    permissions: ['read'],
    bucketScope: 'all',
  },
];

export const Default: Story = {
  args: {
    keys: mockKeys,
  },
};

export const Empty: Story = {
  args: {
    keys: [],
    onCreateOpen: () => {},
  },
};

export const WithBucketsAndPermissions: Story = {
  args: {
    keys: mockKeys,
    showBuckets: true,
    showPermissions: true,
  },
};

export const WithDeleteAction: Story = {
  args: {
    keys: mockKeys,
    showBuckets: true,
    showPermissions: true,
    onDelete: () => Promise.resolve(),
  },
};
