import type { Meta, StoryObj } from '@storybook/react-vite';

import { AccessEndpointsCard } from './AccessEndpointsCard';

const meta: Meta<typeof AccessEndpointsCard> = {
  title: 'Components/AccessEndpointsCard',
  component: AccessEndpointsCard,
};

export default meta;
type Story = StoryObj<typeof AccessEndpointsCard>;

export const Default: Story = {
  args: {
    s3Endpoint: 'https://s3.filone.io',
    s3Path: 's3://my-bucket',
    region: 'eu-west-1',
  },
};
