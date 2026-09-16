import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import type { PolicyActionOrWildcard } from '@filone/shared';

import { PolicyActionFields } from './PolicyActionFields';

function Controlled({ initial }: { initial: PolicyActionOrWildcard[] }) {
  const [value, setValue] = useState(initial);
  return <PolicyActionFields value={value} onChange={setValue} />;
}

const meta: Meta<typeof Controlled> = {
  title: 'Components/PolicyActionFields',
  component: Controlled,
};

export default meta;
type Story = StoryObj<typeof Controlled>;

export const Empty: Story = { args: { initial: [] } };
export const ReadAndList: Story = { args: { initial: ['s3:GetObject', 's3:ListBucket'] } };
export const AllActions: Story = { args: { initial: ['s3:*'] } };
