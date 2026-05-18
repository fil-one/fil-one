import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import { ToggleRow } from './ToggleRow';

const meta: Meta<typeof ToggleRow> = {
  title: 'Components/ToggleRow',
  component: ToggleRow,
  parameters: {
    layout: 'padded',
  },
};

export default meta;
type Story = StoryObj<typeof ToggleRow>;

export const Off: Story = {
  args: {
    label: 'Marketing emails',
    description: 'Receive updates about new features',
    enabled: false,
  },
};

export const On: Story = {
  args: {
    label: 'Marketing emails',
    description: 'Receive updates about new features',
    enabled: true,
  },
};

export const Disabled: Story = {
  args: {
    label: 'Email notifications',
    description: 'Get notified about your uploads and when approaching storage limits',
    enabled: false,
    disabled: true,
  },
};

export const Saving: Story = {
  args: {
    label: 'Marketing emails',
    description: 'Receive updates about new features',
    enabled: true,
    saving: true,
  },
};

export const Interactive: Story = {
  render: () => {
    const [enabled, setEnabled] = useState(false);
    return (
      <ToggleRow
        label="Marketing emails"
        description="Receive updates about new features"
        enabled={enabled}
        onChange={() => setEnabled((v) => !v)}
      />
    );
  },
};
