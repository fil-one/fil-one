import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import { RadioOption } from './RadioOption';

const meta: Meta<typeof RadioOption> = {
  title: 'Components/RadioOption',
  component: RadioOption,
};

export default meta;
type Story = StoryObj<typeof RadioOption>;

export const Unchecked: Story = {
  args: {
    name: 'example',
    value: 'a',
    checked: false,
    onChange: () => {},
    children: 'Option A',
  },
};

export const Checked: Story = {
  args: {
    name: 'example',
    value: 'a',
    checked: true,
    onChange: () => {},
    children: 'Option A',
  },
};

export const InlineGroup: Story = {
  render: () => {
    const options = [
      { value: 'all-buckets', label: 'All buckets' },
      { value: 'specific-buckets', label: 'Specific buckets' },
    ];
    const [value, setValue] = useState('all-buckets');
    return (
      <div className="flex gap-2">
        {options.map((option) => (
          <RadioOption
            key={option.value}
            name="inline"
            value={option.value}
            checked={value === option.value}
            onChange={() => setValue(option.value)}
          >
            {option.label}
          </RadioOption>
        ))}
      </div>
    );
  },
};

export const GridGroup: Story = {
  render: () => {
    const [value, setValue] = useState('never');
    return (
      <div className="grid grid-cols-3 gap-2">
        {[
          { value: 'never', label: 'Never expires' },
          { value: '30d', label: '30 days' },
          { value: 'custom', label: 'Custom' },
        ].map((option) => (
          <RadioOption
            key={option.value}
            name="grid"
            value={option.value}
            checked={value === option.value}
            onChange={() => setValue(option.value)}
          >
            {option.label}
          </RadioOption>
        ))}
      </div>
    );
  },
};
