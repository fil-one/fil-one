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
    description: 'Manage credentials and connect via S3-compatible API',
  },
};

export const WithoutDescription: Story = {
  args: {
    tag: 'h1',
    children: 'Settings',
  },
};

export const Small: Story = {
  args: {
    tag: 'h4',
    size: 'sm',
    children: 'Object details',
  },
};

export const Large: Story = {
  args: {
    tag: 'h3',
    size: 'lg',
    children: 'Dashboard',
  },
};

export const TwoExtraLarge: Story = {
  args: {
    tag: 'h1',
    size: '2xl',
    children: 'Create your account',
    description: 'Start storing objects on Filecoin',
  },
};

export const ThreeExtraLarge: Story = {
  args: {
    tag: 'h1',
    size: '3xl',
    children: 'Welcome to Fil.one',
  },
};

export const AllSizes: Story = {
  render: () => (
    <div className="flex flex-col gap-8">
      <Heading tag="h1" size="3xl">
        3xl — Display heading
      </Heading>
      <Heading tag="h1" size="2xl" description="Auth pages, large titles.">
        2xl — Large title
      </Heading>
      <Heading tag="h1" description="The default page title pattern matching fil-hyperspace.">
        xl — Page title (default)
      </Heading>
      <Heading tag="h3" size="lg">
        lg — Section header
      </Heading>
      <Heading tag="h4" size="sm">
        sm — Subsection label
      </Heading>
    </div>
  ),
};
