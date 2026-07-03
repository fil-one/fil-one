import type { Meta, StoryObj } from '@storybook/react-vite';

import { BucketActionMenu } from './BucketActionMenu';

const meta: Meta<typeof BucketActionMenu> = {
  title: 'Components/BucketActionMenu',
  component: BucketActionMenu,
  args: {
    onDisable: () => {},
  },
  decorators: [
    (Story) => (
      <div className="flex justify-end p-8">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof BucketActionMenu>;

/** Closed menu — click the kebab to reveal the Disable action. */
export const Default: Story = {};
