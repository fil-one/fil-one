import type { Meta, StoryObj } from '@storybook/react-vite';

import { PolicyStatementModal } from './PolicyStatementModal';

const meta: Meta<typeof PolicyStatementModal> = {
  title: 'Components/PolicyStatementModal',
  component: PolicyStatementModal,
  args: {
    open: true,
    onClose: () => {},
    onSubmit: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof PolicyStatementModal>;

export const Add: Story = {};

export const Edit: Story = {
  args: {
    initial: {
      Sid: 'team',
      Effect: 'Allow',
      Principal: ['user-1'],
      Action: ['s3:GetObject', 's3:ListBucket'],
    },
  },
};

export const DenyEveryone: Story = {
  args: {
    initial: { Effect: 'Deny', Principal: '*', Action: ['s3:DeleteObject'] },
  },
};

export const AllActions: Story = {
  args: {
    initial: { Effect: 'Allow', Principal: '*', Action: ['s3:*'] },
  },
};

export const RosterStatement: Story = {
  name: 'Roster statement, name locked',
  args: {
    initial: { Sid: 'filone-owners', Effect: 'Allow', Principal: ['user-1'], Action: ['s3:*'] },
  },
};
