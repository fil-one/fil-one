import type { Meta, StoryObj } from '@storybook/react-vite';

import { Heading } from './Heading';

const meta: Meta<typeof Heading> = {
  title: 'Components/Heading',
  component: Heading,
};

export default meta;
type Story = StoryObj<typeof Heading>;

export const Default: Story = {
  args: {
    tag: 'h1',
    children: 'API Keys',
  },
};

export const PageHeading: Story = {
  args: {
    tag: 'h3',
    children: 'Dashboard',
    variant: 'page-heading',
  },
};

export const SectionHeading: Story = {
  args: {
    tag: 'h3',
    children: 'Dashboard',
    variant: 'section-heading',
  },
};

export const CardHeading: Story = {
  args: {
    tag: 'h4',
    children: 'Object details',
    variant: 'card-heading',
  },
};
