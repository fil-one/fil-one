import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import { AccessKeyExpirationFields, type ExpirationOption } from './AccessKeyExpirationFields';

const meta: Meta<typeof AccessKeyExpirationFields> = {
  title: 'Components/AccessKeyExpirationFields',
  component: AccessKeyExpirationFields,
};

export default meta;
type Story = StoryObj<typeof AccessKeyExpirationFields>;

export const Never: Story = {
  args: {
    value: 'never',
    customDate: null,
  },
};

export const ThirtyDays: Story = {
  args: {
    value: '30d',
    customDate: null,
  },
};

export const Custom: Story = {
  args: {
    value: 'custom',
    customDate: '2026-12-31',
  },
};

export const Interactive: Story = {
  render: () => {
    const [value, setValue] = useState<ExpirationOption>('never');
    const [customDate, setCustomDate] = useState<string | null>(null);
    return (
      <AccessKeyExpirationFields
        value={value}
        customDate={customDate}
        onChange={setValue}
        onDateChange={setCustomDate}
      />
    );
  },
};
