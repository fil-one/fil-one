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
    retentionMode: 'governance',
    retentionDuration: 30,
    retentionDurationType: 'd',
  },
};

export const Compliance: Story = {
  args: {
    retentionMode: 'compliance',
    retentionDuration: 1,
    retentionDurationType: 'y',
  },
};

export const WithTrialConstraint: Story = {
  args: {
    retentionMode: 'governance',
    retentionDuration: 30,
    retentionDurationType: 'd',
    trialDaysLeft: 14,
  },
};

export const ExceedingTrial: Story = {
  args: {
    retentionMode: 'governance',
    retentionDuration: 60,
    retentionDurationType: 'd',
    trialDaysLeft: 14,
  },
};

export const Interactive: Story = {
  render: () => {
    const [retentionMode, setRetentionMode] = useState<RetentionMode>('governance');
    const [retentionDuration, setRetentionDuration] = useState(30);
    const [retentionDurationType, setRetentionDurationType] = useState<RetentionDurationType>('d');

    return (
      <div className="max-w-md">
        <ObjectSettingsFields
          retentionMode={retentionMode}
          onRetentionModeChange={setRetentionMode}
          retentionDuration={retentionDuration}
          onRetentionDurationChange={setRetentionDuration}
          retentionDurationType={retentionDurationType}
          onRetentionDurationTypeChange={setRetentionDurationType}
          trialDaysLeft={14}
        />
      </div>
    );
  },
};
