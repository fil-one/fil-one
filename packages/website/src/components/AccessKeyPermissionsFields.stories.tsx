import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import type { AccessKeyPermission, GranularPermission } from '@filone/shared';

import { AccessKeyPermissionsFields } from './AccessKeyPermissionsFields';

const noop = () => {};

const meta: Meta<typeof AccessKeyPermissionsFields> = {
  title: 'Components/AccessKeyPermissionsFields',
  component: AccessKeyPermissionsFields,
  args: {
    onChange: noop,
    onGranularPermissionsChange: noop,
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
    value: ['read', 'write', 'list', 'delete'],
    granularPermissions: [],
  },
};

export const WithGranularPermissions: Story = {
  args: {
    value: ['read', 'write'],
    granularPermissions: ['GetObjectVersion', 'GetObjectRetention', 'PutObjectRetention'],
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
      />
    );
  },
};
