import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import type { PolicyStatement } from '@filone/shared';

import { PolicyPrincipalFields } from './PolicyPrincipalFields';

function Controlled({ initial }: { initial: PolicyStatement['principal'] }) {
  const [value, setValue] = useState(initial);
  return <PolicyPrincipalFields value={value} onChange={setValue} />;
}

const meta: Meta<typeof Controlled> = {
  title: 'Components/PolicyPrincipalFields',
  component: Controlled,
};

export default meta;
type Story = StoryObj<typeof Controlled>;

export const Everyone: Story = { args: { initial: '*' } };
export const SpecificMembers: Story = { args: { initial: ['user-1'] } };
