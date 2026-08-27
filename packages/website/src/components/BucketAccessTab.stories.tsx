import type { Meta, StoryObj } from '@storybook/react-vite';

import type { AccessKey } from '@filone/shared';
import { OrgRole, S3Region } from '@filone/shared';

import { BucketAccessTab } from './BucketAccessTab';

// `createdBy` matches the seeded `/me` fixture's userId, so a Member owns the
// first key and not the second — which is the whole point of the Member story.
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
    region: S3Region.UsEast1,
    createdBy: 'user-1',
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
    region: S3Region.UsEast1,
    createdBy: 'someone-else',
  },
];

const meta: Meta<typeof BucketAccessTab> = {
  title: 'Components/BucketAccessTab',
  component: BucketAccessTab,
  args: {
    bucketName: 'my-bucket',
    s3Endpoint: 'https://s3.filone.org',
    region: S3Region.UsEast1,
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

/** A failed request is not an empty bucket, and says so. */
export const LoadFailed: Story = {
  args: {
    accessKeys: [],
    accessKeysLoading: false,
    accessKeysError: true,
    accessKeysErrorMessage: 'Failed to load access keys for this bucket',
  },
};

/** A Member revokes the key they minted and not the one they did not. */
export const AsMember: Story = {
  args: {
    accessKeys: mockKeys,
    accessKeysLoading: false,
  },
  parameters: { role: OrgRole.Member },
};

/** ReadOnly mints nothing and revokes nothing; the endpoints card still helps. */
export const AsReadOnly: Story = {
  args: {
    accessKeys: mockKeys,
    accessKeysLoading: false,
  },
  parameters: { role: OrgRole.ReadOnly },
};
