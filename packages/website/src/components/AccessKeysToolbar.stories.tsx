import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import type { AccessKey } from '@filone/shared';
import { S3Region } from '@filone/shared';

import { AccessKeysTable } from './AccessKeysTable';
import { AccessKeysToolbar } from './AccessKeysToolbar';
import {
  EMPTY_ACCESS_KEY_FILTERS,
  accessKeyRegions,
  filterAccessKeys,
} from '../lib/access-key-table.js';

const KEYS: AccessKey[] = [
  {
    id: '1',
    type: 'service',
    keyName: 'production',
    accessKeyId: 'VQFZ30EZ8N0L8RMLRN5P',
    createdAt: '2026-04-17T10:00:00Z',
    status: 'active',
    permissions: ['read', 'write', 'list'],
    bucketScope: 'all',
    region: S3Region.EuWest1,
  },
  {
    id: '2',
    type: 'service',
    keyName: 'new-key',
    accessKeyId: 'SJDN1137MOSOMX4KR6D5',
    createdAt: '2026-08-13T10:00:00Z',
    status: 'expired',
    expiresAt: '2026-09-12',
    permissions: ['read', 'write', 'list', 'delete'],
    bucketScope: 'specific',
    buckets: ['fgrc-ltda', 'filipa-1'],
    region: S3Region.EuWest1,
  },
  {
    id: '3',
    type: 'service',
    keyName: 'test',
    accessKeyId: 'ZEZ3SPYRYHHUXN4XUSAJ',
    createdAt: '2026-09-14T10:00:00Z',
    status: 'active',
    permissions: ['read', 'list'],
    bucketScope: 'all',
    region: S3Region.EuWest1,
  },
  {
    id: '4',
    type: 'service',
    keyName: 'test-key-forge-us-east',
    accessKeyId: 'z6MkfD2e6PQLZGVzi7FQAYfSCQYwnB97AD8PdWuEDTXZnwEd',
    createdAt: '2026-09-18T10:00:00Z',
    status: 'active',
    permissions: ['read', 'write', 'list'],
    bucketScope: 'specific',
    buckets: ['test-bucket-forge-us-east'],
    region: S3Region.UsEast9,
  },
  {
    id: '5',
    type: 'principal',
    principalId: 'any-user',
    keyName: 'Personal',
    accessKeyId: 'z6Mkj3sQvqR63MfKNVgJJzCf29000000000000000000000',
    createdAt: '2026-09-20T10:00:00Z',
    status: 'active',
    region: S3Region.EuCentral3,
  },
];

/** The toolbar above a live table, filtering the way the API keys page does. */
function Harness({ keys }: { keys: AccessKey[] }) {
  const [filters, setFilters] = useState(EMPTY_ACCESS_KEY_FILTERS);
  const shown = filterAccessKeys(keys, filters);
  return (
    <>
      <AccessKeysToolbar
        filters={filters}
        onChange={setFilters}
        keys={keys}
        regions={accessKeyRegions(keys)}
        matchCount={shown.length}
      />
      <AccessKeysTable keys={shown} showRegion showBuckets showPermissions />
    </>
  );
}

const meta: Meta<typeof Harness> = {
  title: 'Components/AccessKeysToolbar',
  component: Harness,
};

export default meta;
type Story = StoryObj<typeof Harness>;

/** Every filter shows: the keys span regions, statuses and both types. */
export const AllFilters: Story = { args: { keys: KEYS } };

/** Service keys in one region and all active: only the search is worth showing. */
export const SearchOnly: Story = {
  args: {
    keys: KEYS.filter((key) => key.type === 'service' && key.status === 'active').map((key) => ({
      ...key,
      region: S3Region.EuWest1,
    })),
  },
};
