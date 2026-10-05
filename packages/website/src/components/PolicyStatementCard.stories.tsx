import type { Meta, StoryObj } from '@storybook/react-vite';

import { PolicyStatementCard } from './PolicyStatementCard';

const names: Record<string, string> = {
  owner: 'Ada Lovelace',
  admin: 'Ben Okri',
  m1: 'Cy Twombly',
  m2: 'Di Brandt',
  m3: 'Ed Ruscha',
};

const meta: Meta<typeof PolicyStatementCard> = {
  title: 'Components/PolicyStatementCard',
  component: PolicyStatementCard,
  args: {
    index: 0,
    memberName: (id: string) => names[id],
    onEdit: () => {},
    onRemove: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof PolicyStatementCard>;

export const Allow: Story = {
  args: {
    statement: {
      Sid: 'team',
      Effect: 'Allow',
      Principal: ['m1', 'm2'],
      Action: ['s3:GetObject', 's3:ListBucket', 's3:PutObject', 's3:DeleteObject'],
    },
  },
};

export const Deny: Story = {
  args: {
    statement: {
      Effect: 'Deny',
      Principal: ['m1'],
      Action: ['s3:PutObjectRetention', 's3:PutObjectLegalHold'],
    },
    index: 1,
  },
};

export const Everyone: Story = {
  args: {
    statement: { Effect: 'Allow', Principal: '*', Action: ['s3:GetObject', 's3:ListBucket'] },
  },
};

export const ManyMembersAllActions: Story = {
  args: {
    statement: {
      Sid: 'filone-owners',
      Effect: 'Allow',
      Principal: ['owner', 'admin', 'm1', 'm2', 'm3', 'unknown-id'],
      Action: ['s3:*'],
    },
  },
};

export const WithoutControls: Story = {
  name: 'Without edit and remove',
  args: {
    statement: { Effect: 'Allow', Principal: ['m1'], Action: ['s3:GetObject'] },
    onEdit: undefined,
    onRemove: undefined,
  },
};
