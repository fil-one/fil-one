import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import type { AccessKeyPermission, GranularPermission } from '@filone/shared';
import { S3Region } from '@filone/shared';

import { AccessKeyPermissionsFields } from './AccessKeyPermissionsFields';

const noop = () => {};

const meta: Meta<typeof AccessKeyPermissionsFields> = {
  title: 'Components/AccessKeyPermissionsFields',
  component: AccessKeyPermissionsFields,
  args: {
    onChange: noop,
    onGranularPermissionsChange: noop,
    region: S3Region.UsEast1,
  },
};

export default meta;
type Story = StoryObj<typeof AccessKeyPermissionsFields>;

export const NoneSelected: Story = {
  args: {
    value: [],
    granularPermissions: [],
  },
};

export const AllSelected: Story = {
  args: {
    value: [
      'read',
      'write',
      'list',
      'delete',
      'GetBucketVersioning',
      'GetBucketObjectLockConfiguration',
      'CreateBucket',
      'DeleteBucket',
    ],
    granularPermissions: [],
  },
};

export const WithGranularPermissions: Story = {
  args: {
    value: ['read', 'write'],
    granularPermissions: ['GetObjectVersion', 'GetObjectRetention', 'PutObjectRetention'],
  },
};

export const WithBucketManagement: Story = {
  args: {
    value: ['read', 'CreateBucket', 'DeleteBucket'],
    granularPermissions: [],
  },
};

export const BucketManagementUnsupported: Story = {
  args: {
    value: ['read'],
    granularPermissions: [],
    region: S3Region.EuWest1,
  },
};

export const Interactive: Story = {
  render: () => {
    const [value, setValue] = useState<AccessKeyPermission[]>(['read', 'list']);
    const [granular, setGranular] = useState<GranularPermission[]>([]);
    return (
      <AccessKeyPermissionsFields
        value={value}
        onChange={setValue}
        granularPermissions={granular}
        onGranularPermissionsChange={setGranular}
        region={S3Region.UsEast1}
      />
    );
  },
};
