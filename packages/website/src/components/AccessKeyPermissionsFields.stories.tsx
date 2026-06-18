import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import type { AccessKeyPermission } from '@filone/shared';
import { DEFAULT_ACCESS_KEY_PERMISSIONS, ACCESS_KEY_PERMISSIONS } from '@filone/shared';

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
    value: DEFAULT_ACCESS_KEY_PERMISSIONS,
  },
};

export const AllSelected: Story = {
  args: {
    value: [...ACCESS_KEY_PERMISSIONS],
  },
};

export const Interactive: Story = {
  render: () => {
    const [value, setValue] = useState<AccessKeyPermission[]>(DEFAULT_ACCESS_KEY_PERMISSIONS);
    return <AccessKeyPermissionsFields value={value} onChange={setValue} />;
  },
};
