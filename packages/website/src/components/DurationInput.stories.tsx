import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import { DurationInput } from './DurationInput';

const meta: Meta<typeof DurationInput> = {
  title: 'Components/DurationInput',
  component: DurationInput,
};

export default meta;
type Story = StoryObj<typeof DurationInput>;

const UNITS = [
  { value: 'd', label: 'Days' },
  { value: 'y', label: 'Years' },
];

export const Default: Story = {
  args: {
    value: 15,
    unit: 'd',
    units: UNITS,
    min: 1,
  },
};

export const Years: Story = {
  args: {
    value: 1,
    unit: 'y',
    units: UNITS,
    min: 1,
  },
};

export const Invalid: Story = {
  args: {
    value: 60,
    unit: 'd',
    units: UNITS,
    min: 1,
    invalid: true,
  },
};

export const Warning: Story = {
  render: () => (
    <div className="flex flex-col gap-2.5">
      <label htmlFor="lock-period" className="text-xs font-medium text-zinc-900">
        Lock period
      </label>
      <DurationInput
        numberInputId="lock-period"
        value={12}
        onValueChange={() => {}}
        unit="d"
        onUnitChange={() => {}}
        units={UNITS}
        min={1}
        invalid
        expiresLabel="Expires Apr 29, 2026"
      />
      <p className="text-[11px] text-amber-600">
        Exceeds your 7-day trial period. Objects cannot be deleted until this period expires, but
        your trial ends before then.
      </p>
    </div>
  ),
};

export const Disabled: Story = {
  args: {
    value: 15,
    unit: 'd',
    units: UNITS,
    min: 1,
    disabled: true,
  },
};

export const Interactive: Story = {
  render: () => {
    const [value, setValue] = useState(15);
    const [unit, setUnit] = useState('d');
    return (
      <div className="flex flex-col gap-2">
        <DurationInput
          value={value}
          onValueChange={setValue}
          unit={unit}
          onUnitChange={setUnit}
          units={UNITS}
          min={1}
        />
        <p className="text-xs text-zinc-500">
          Selected: {value} {unit === 'd' ? 'days' : 'years'}
        </p>
      </div>
    );
  },
};
