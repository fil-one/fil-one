import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import type { RetentionDurationType, RetentionMode } from '@filone/shared';

import { ObjectSettingsFields } from './ObjectSettingsFields';

const meta: Meta<typeof ObjectSettingsFields> = {
  title: 'Components/ObjectSettingsFields',
  component: ObjectSettingsFields,
};

export default meta;
type Story = StoryObj<typeof ObjectSettingsFields>;

export const Default: Story = {
  args: {
    versioning: false,
    lock: false,
    retentionEnabled: false,
    retentionMode: 'governance',
    retentionDuration: 30,
    retentionDurationType: 'd',
  },
};

export const VersioningEnabled: Story = {
  args: {
    versioning: true,
    lock: false,
    retentionEnabled: false,
    retentionMode: 'governance',
    retentionDuration: 30,
    retentionDurationType: 'd',
  },
};

export const AllEnabled: Story = {
  args: {
    versioning: true,
    lock: true,
    retentionEnabled: true,
    retentionMode: 'compliance',
    retentionDuration: 1,
    retentionDurationType: 'y',
  },
};

export const Interactive: Story = {
  render: () => {
    const [versioning, setVersioning] = useState(false);
    const [lock, setLock] = useState(false);
    const [retentionEnabled, setRetentionEnabled] = useState(false);
    const [retentionMode, setRetentionMode] = useState<RetentionMode>('governance');
    const [retentionDuration, setRetentionDuration] = useState(30);
    const [retentionDurationType, setRetentionDurationType] = useState<RetentionDurationType>('d');

    return (
      <div className="max-w-md">
        <ObjectSettingsFields
          versioning={versioning}
          onVersioningChange={setVersioning}
          lock={lock}
          onLockChange={setLock}
          retentionEnabled={retentionEnabled}
          onRetentionEnabledChange={setRetentionEnabled}
          retentionMode={retentionMode}
          onRetentionModeChange={setRetentionMode}
          retentionDuration={retentionDuration}
          onRetentionDurationChange={setRetentionDuration}
          retentionDurationType={retentionDurationType}
          onRetentionDurationTypeChange={setRetentionDurationType}
        />
      </div>
    );
  },
};
