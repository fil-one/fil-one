import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import { SearchInput } from './SearchInput';

/** Live state, so the story shows the clear button arriving and leaving. */
function Harness({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return (
    <SearchInput
      value={value}
      onChange={setValue}
      placeholder="Search keys"
      aria-label="Search keys"
      className="w-64"
    />
  );
}

const meta: Meta<typeof Harness> = {
  title: 'Components/SearchInput',
  component: Harness,
};

export default meta;
type Story = StoryObj<typeof Harness>;

export const Empty: Story = { args: { initial: '' } };

/** With text: the clear button shows at the end of the field. */
export const WithQuery: Story = { args: { initial: 'new' } };
