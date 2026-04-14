import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import { Switch } from './Switch';

const meta: Meta<typeof Switch> = {
  title: 'Components/Switch',
  component: Switch,
};

export default meta;
type Story = StoryObj<typeof Switch>;

export const Off: Story = {
  args: {
    checked: false,
    'aria-label': 'Toggle setting',
  },
};

export const On: Story = {
  args: {
    checked: true,
    'aria-label': 'Toggle setting',
  },
};

export const Disabled: Story = {
  args: {
    checked: false,
    disabled: true,
    'aria-label': 'Toggle setting',
  },
};

export const Interactive: Story = {
  render: () => {
    const [checked, setChecked] = useState(false);
    return <Switch checked={checked} onChange={setChecked} aria-label="Toggle setting" />;
  },
};
