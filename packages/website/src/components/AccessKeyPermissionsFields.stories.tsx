import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import type { GranularPermission } from '@filone/shared';
import { DEFAULT_GRANULAR_PERMISSIONS, GRANULAR_PERMISSIONS } from '@filone/shared';

import { AccessKeyPermissionsFields } from './AccessKeyPermissionsFields';

const noop = () => {};

const meta: Meta<typeof AccessKeyPermissionsFields> = {
  title: 'Components/AccessKeyPermissionsFields',
  component: AccessKeyPermissionsFields,
  args: {
    onChange: noop,
  },
};

export default meta;
type Story = StoryObj<typeof AccessKeyPermissionsFields>;

export const NoneSelected: Story = {
  args: {
    value: [],
  },
};

export const DefaultSelected: Story = {
  args: {
    value: DEFAULT_GRANULAR_PERMISSIONS,
  },
};

export const AllSelected: Story = {
  args: {
    value: [...GRANULAR_PERMISSIONS],
  },
};

export const Interactive: Story = {
  render: () => {
    const [value, setValue] = useState<GranularPermission[]>(DEFAULT_GRANULAR_PERMISSIONS);
    return <AccessKeyPermissionsFields value={value} onChange={setValue} />;
  },
};
