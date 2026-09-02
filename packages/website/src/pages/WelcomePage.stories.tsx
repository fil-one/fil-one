import type { Meta, StoryObj } from '@storybook/react-vite';

import { WelcomePage } from './WelcomePage';

const meta: Meta<typeof WelcomePage> = {
  title: 'Pages/WelcomePage',
  component: WelcomePage,
  parameters: { fullBleed: true, layout: 'fullscreen' },
  args: {
    suggestedName: 'Acme',
    onNamed: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof WelcomePage>;

/** The common case: the derived name is already right, so Continue is the answer. */
export const Default: Story = {};

/** Two words give the monogram two letters, which is what tells organizations apart. */
export const TwoWordName: Story = {
  args: { suggestedName: 'Acme Storage' },
};

/**
 * The fallback name, for an account whose identity provider offered neither a
 * display name nor a company domain.
 */
export const GenericFallback: Story = {
  args: { suggestedName: 'My Organization' },
};

/** Cleared field: the monogram empties and Continue is disabled rather than refusing later. */
export const Empty: Story = {
  args: { suggestedName: '' },
};

/** The longest name the field accepts, to check it wraps rather than overflows. */
export const LongName: Story = {
  args: { suggestedName: 'Northwind Traders International Holdings Group' },
};
