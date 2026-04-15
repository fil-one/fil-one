import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import { TextArea } from './TextArea';

const meta: Meta<typeof TextArea> = {
  title: 'Components/TextArea',
  component: TextArea,
};

export default meta;
type Story = StoryObj<typeof TextArea>;

export const Default: Story = {
  args: {
    placeholder: 'Enter a description...',
  },
};

export const CustomRows: Story = {
  args: {
    placeholder: 'Taller textarea',
    rows: 8,
  },
};

export const WithValue: Story = {
  args: {
    value: 'This is some pre-filled content in the textarea.',
  },
};

export const Interactive: Story = {
  render: () => {
    const [value, setValue] = useState('');
    return <TextArea value={value} onChange={setValue} placeholder="Type something..." />;
  },
};
