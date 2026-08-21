import type { Meta, StoryObj } from '@storybook/react-vite';

import { AuthCard } from './AuthCard';
import { Heading } from './Heading/Heading';

const meta: Meta<typeof AuthCard> = {
  title: 'Components/AuthCard',
  component: AuthCard,
  parameters: { fullBleed: true, layout: 'fullscreen' },
};

export default meta;
type Story = StoryObj<typeof AuthCard>;

/** The shared shell in isolation, so card-level changes can be reviewed without a page. */
export const Default: Story = {
  args: {
    children: (
      <>
        <Heading tag="h1" size="lg" balance className="font-normal tracking-tight">
          Card heading
        </Heading>
        <p className="mt-2 text-sm text-(--color-paragraph-text)">
          Supporting copy sits directly under the heading, grouped as one unit.
        </p>
        <a href="#" className="button button--primary button--lg mt-6 w-full justify-center py-3.5">
          Primary action
        </a>
      </>
    ),
  },
};

/** With the optional footer line rendered below the card. */
export const WithFooter: Story = {
  args: {
    ...Default.args,
    footer: (
      <p className="text-xs text-(--color-paragraph-text-subtle)">Secondary line below the card</p>
    ),
  },
};
