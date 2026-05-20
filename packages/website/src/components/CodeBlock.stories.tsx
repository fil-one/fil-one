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
    code: 'npm install @filone/sdk',
  },
};

export const WithLanguage: Story = {
  args: {
    code: `aws s3 cp ./my-file.txt s3://my-bucket/ \\
  --endpoint-url https://s3.filone.io`,
    language: 'bash',
  },
};

export const MultiLine: Story = {
  args: {
    code: `import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const client = new S3Client({
  region: "us-east-1",
  endpoint: "https://s3.filone.io",
});

await client.send(new PutObjectCommand({
  Bucket: "my-bucket",
  Key: "hello.txt",
  Body: "Hello, Filecoin!",
}));`,
    language: 'typescript',
  },
};
