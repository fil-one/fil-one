import type { Meta, StoryObj } from '@storybook/react-vite';

import { CodeBlock } from './CodeBlock';

const meta: Meta<typeof CodeBlock> = {
  title: 'Components/CodeBlock',
  component: CodeBlock,
};

export default meta;
type Story = StoryObj<typeof CodeBlock>;

export const Default: Story = {
  args: {
    code: 'aws s3 ls --endpoint-url https://s3.fil.one',
  },
};

export const WithLanguage: Story = {
  args: {
    code: `import boto3

s3 = boto3.client(
    "s3",
    endpoint_url="https://s3.fil.one",
    region_name="us-east-1",
)`,
    language: 'Python',
  },
};
