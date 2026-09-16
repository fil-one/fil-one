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
      sid: 'team',
      effect: 'allow',
      principal: ['m1', 'm2'],
      action: ['s3:GetObject', 's3:ListBucket', 's3:PutObject', 's3:DeleteObject'],
    },
  },
};

export const Deny: Story = {
  args: {
    statement: {
      effect: 'deny',
      principal: ['m1'],
      action: ['s3:PutObjectRetention', 's3:PutObjectLegalHold'],
    },
    index: 1,
  },
};

export const Everyone: Story = {
  args: {
    statement: { effect: 'allow', principal: '*', action: ['s3:GetObject', 's3:ListBucket'] },
  },
};

export const ManyMembersAllActions: Story = {
  args: {
    statement: {
      sid: 'filone-owners',
      effect: 'allow',
      principal: ['owner', 'admin', 'm1', 'm2', 'm3', 'unknown-id'],
      action: ['s3:*'],
    },
  },
};

export const WithoutControls: Story = {
  name: 'Without edit and remove',
  args: {
    statement: { effect: 'allow', principal: ['m1'], action: ['s3:GetObject'] },
    onEdit: undefined,
    onRemove: undefined,
  },
};
