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
      sid: 'team',
      effect: 'allow',
      principal: ['user-1'],
      action: ['s3:GetObject', 's3:ListBucket'],
    },
  },
};

export const DenyEveryone: Story = {
  args: {
    initial: { effect: 'deny', principal: '*', action: ['s3:DeleteObject'] },
  },
};

export const AllActions: Story = {
  args: {
    initial: { effect: 'allow', principal: '*', action: ['s3:*'] },
  },
};

export const RosterStatement: Story = {
  name: 'Roster statement, name locked',
  args: {
    initial: { sid: 'filone-owners', effect: 'allow', principal: ['user-1'], action: ['s3:*'] },
  },
};
