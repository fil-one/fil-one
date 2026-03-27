import type { Meta, StoryObj } from '@storybook/react-vite';
import { DatabaseIcon, FileIcon, UploadSimpleIcon, PlusIcon } from '@phosphor-icons/react/dist/ssr';

import { EmptyStateCard } from './EmptyStateCard';

const meta: Meta<typeof EmptyStateCard> = {
  title: 'Components/EmptyStateCard',
  component: EmptyStateCard,
};

export default meta;
type Story = StoryObj<typeof EmptyStateCard>;

export const Default: Story = {
  args: {
    icon: DatabaseIcon,
    title: 'No items yet',
    titleTag: 'h2',
    description: 'Get started by creating your first item.',
  },
};

export const WithAction: Story = {
  args: {
    icon: UploadSimpleIcon,
    title: 'No uploads',
    titleTag: 'h2',
    description: 'Upload your first file to get started.',
    action: { label: 'Upload file' },
  },
};

export const WithHrefAction: Story = {
  args: {
    icon: PlusIcon,
    title: 'No buckets yet',
    titleTag: 'h2',
    description: 'Create your first bucket to start storing objects.',
    action: { label: 'Create bucket', href: '/buckets/new' },
  },
};

export const Files: Story = {
  args: {
    icon: FileIcon,
    title: 'No files found',
    titleTag: 'h3',
    description: 'This bucket is empty. Upload files to see them here.',
    action: { label: 'Upload files' },
  },
};
