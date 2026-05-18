import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import { Checkbox } from './Checkbox';

const meta: Meta<typeof Checkbox> = {
  title: 'Components/Checkbox',
  component: Checkbox,
};

export default meta;
type Story = StoryObj<typeof Checkbox>;

export const Unchecked: Story = {
  args: {
    checked: false,
    'aria-label': 'Unchecked checkbox',
  },
};

export const Checked: Story = {
  args: {
    checked: true,
    'aria-label': 'Checked checkbox',
  },
};

export const Disabled: Story = {
  args: {
    checked: false,
    disabled: true,
    'aria-label': 'Disabled checkbox',
  },
};

export const Interactive: Story = {
  render: () => {
    const [checked, setChecked] = useState(false);
    return <Checkbox aria-label="Interactive checkbox" checked={checked} onChange={setChecked} />;
  },
};
