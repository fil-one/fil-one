import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import type { AccessKeyPermission } from '@filone/shared';

import { AccessKeyPermissionsFields } from './AccessKeyPermissionsFields';

const meta: Meta<typeof AccessKeyPermissionsFields> = {
  title: 'Components/AccessKeyPermissionsFields',
  component: AccessKeyPermissionsFields,
};

export default meta;
type Story = StoryObj<typeof AccessKeyPermissionsFields>;

export const NoneSelected: Story = {
  args: {
    value: [],
  },
};

export const AllSelected: Story = {
  args: {
    value: ['read', 'write', 'list', 'delete'],
  },
};

export const ReadOnly: Story = {
  args: {
    value: ['read', 'list'],
  },
};

export const Interactive: Story = {
  render: () => {
    const [value, setValue] = useState<AccessKeyPermission[]>(['read', 'list']);
    return <AccessKeyPermissionsFields value={value} onChange={setValue} />;
  },
};
