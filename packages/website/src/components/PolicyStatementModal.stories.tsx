import type { Meta, StoryObj } from '@storybook/react-vite';
import { OrgRole } from '@filone/shared';

import { ADA_ID, BEN_ID, storyRoster, withMembers } from '../lib/story-members';
import { PolicyStatementModal } from './PolicyStatementModal';

const meta: Meta<typeof PolicyStatementModal> = {
  title: 'Components/PolicyStatementModal',
  component: PolicyStatementModal,
  args: {
    open: true,
    onClose: () => {},
    onSubmit: () => {},
  },
  decorators: [withMembers(storyRoster)],
};

export default meta;
type Story = StoryObj<typeof PolicyStatementModal>;

/** First open: nothing picked yet, and no error until a field is touched. */
export const Add: Story = {};

export const Edit: Story = {
  args: {
    initial: {
      Sid: 'team',
      Effect: 'Allow',
      Principal: [ADA_ID],
      Action: ['s3:GetObject', 's3:ListBucket'],
    },
  },
};

export const DenyEveryone: Story = {
  args: {
    initial: { Effect: 'Deny', Principal: '*', Action: ['s3:DeleteObject'] },
  },
};

/** A Deny naming members shows no alert: the alert depends on the principal as well as the effect. */
export const DenySpecificMembers: Story = {
  args: {
    initial: { Effect: 'Deny', Principal: [ADA_ID, BEN_ID], Action: ['s3:DeleteObject'] },
  },
};

export const AllActions: Story = {
  args: {
    initial: { Effect: 'Allow', Principal: '*', Action: ['s3:*'] },
  },
};

/** An Admin opening an Owner's s3:* statement keeps it and can save it unchanged. */
export const AdminEditsOwnersAllActions: Story = {
  args: {
    initial: { Sid: 'owners', Effect: 'Allow', Principal: '*', Action: ['s3:*'] },
  },
  parameters: { role: OrgRole.Admin },
};

/** An Admin keeps a stored legal hold and is offered no retention write to add. */
export const AdminEditsStoredLegalHold: Story = {
  args: {
    initial: {
      Effect: 'Allow',
      Principal: [ADA_ID],
      Action: ['s3:GetObject', 's3:PutObjectLegalHold'],
    },
  },
  parameters: { role: OrgRole.Admin },
};

/** An Admin editing a Deny on a retention write keeps the deny as written. */
export const AdminEditsDenyOnRetention: Story = {
  args: {
    initial: {
      Effect: 'Deny',
      Principal: [ADA_ID],
      Action: ['s3:DeleteObject', 's3:PutObjectRetention'],
    },
  },
  parameters: { role: OrgRole.Admin },
};
