import type { Meta, StoryObj } from '@storybook/react-vite';

import { buildStatement } from '@filone/shared';

import { PolicyStatementCard } from './PolicyStatementCard';

const memberNamesById: Record<string, string> = {
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
    getMemberName: (id: string) => memberNamesById[id],
    actions: { onEdit: () => {}, onRemove: () => {} },
  },
};

export default meta;
type Story = StoryObj<typeof PolicyStatementCard>;

export const AllowStatement: Story = {
  args: {
    statement: buildStatement({
      bucketName: 'photos',
      principal: ['m1', 'm2'],
      actions: ['s3:GetObject', 's3:ListBucket', 's3:PutObject', 's3:DeleteObject'],
      sid: 'team',
    }),
  },
};

export const DenyStatement: Story = {
  args: {
    statement: buildStatement({
      bucketName: 'photos',
      effect: 'Deny',
      principal: ['m1'],
      actions: ['s3:PutObjectRetention', 's3:PutObjectLegalHold'],
    }),
    index: 1,
  },
};

export const EveryoneInOrganization: Story = {
  args: {
    statement: buildStatement({
      bucketName: 'photos',
      principal: '*',
      actions: ['s3:GetObject', 's3:ListBucket'],
    }),
  },
};

export const StatementWithFoldedMembers: Story = {
  args: {
    statement: buildStatement({
      bucketName: 'photos',
      principal: ['owner', 'admin', 'm1', 'm2', 'm3', 'unknown-id'],
      actions: ['s3:*'],
      sid: 'owners',
    }),
  },
};

export const UnknownMember: Story = {
  args: {
    statement: buildStatement({
      bucketName: 'photos',
      principal: ['m1', 'removed-id'],
      actions: ['s3:GetObject'],
    }),
  },
};

export const UnknownMembers: Story = {
  args: {
    statement: buildStatement({
      bucketName: 'photos',
      principal: ['m1', 'removed-id', 'another-unknown-id'],
      actions: ['s3:GetObject'],
    }),
  },
};

export const ProtectGroup: Story = {
  args: {
    statement: buildStatement({
      bucketName: 'photos',
      principal: ['m1'],
      actions: [
        's3:GetObjectRetention',
        's3:GetObjectLegalHold',
        's3:PutObjectRetention',
        's3:PutObjectLegalHold',
      ],
    }),
  },
};

export const ReadOnly: Story = {
  name: 'Without edit and remove',
  args: {
    statement: buildStatement({
      bucketName: 'photos',
      principal: ['m1'],
      actions: ['s3:GetObject'],
    }),
    actions: undefined,
  },
};
