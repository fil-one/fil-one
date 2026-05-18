import type { Meta, StoryObj } from '@storybook/react-vite';

import { BaseLink } from './BaseLink';

const meta: Meta<typeof BaseLink> = {
  title: 'Components/BaseLink',
  component: BaseLink,
};

export default meta;
type Story = StoryObj<typeof BaseLink>;

export const ExternalLink: Story = {
  args: {
    href: 'https://docs.filecoin.io',
    children: 'Filecoin Documentation',
  },
};

export const MailtoLink: Story = {
  args: {
    href: 'mailto:support@filone.io',
    children: 'Contact Support',
  },
};
