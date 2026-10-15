import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { OrgRole } from '@filone/shared';
import type { PolicyActionOrWildcard } from '@filone/shared';

import { PolicyActionFields } from './PolicyActionFields';

function Controlled({ initial }: { initial: PolicyActionOrWildcard[] }) {
  const [value, setValue] = useState(initial);
  return <PolicyActionFields value={value} onChange={setValue} />;
}

const meta: Meta<typeof Controlled> = {
  title: 'Components/PolicyActionFields',
  component: Controlled,
};

export default meta;
type Story = StoryObj<typeof Controlled>;

export const Empty: Story = { args: { initial: [] } };
export const ReadAndList: Story = { args: { initial: ['s3:GetObject', 's3:ListBucket'] } };
export const AllActions: Story = { args: { initial: ['s3:*'] } };

/** An Owner with the two retention writes picked and the reads left out. */
export const PartialProtection: Story = {
  args: { initial: ['s3:PutObjectRetention', 's3:PutObjectLegalHold'] },
};

/** An Admin is offered no All actions row and no retention writes. */
export const AsAdmin: Story = {
  args: { initial: [] },
  parameters: { role: OrgRole.Admin },
};

/** An Admin keeps a retention write the statement already carries and may remove it. */
export const AdminKeepsStoredRetention: Story = {
  args: { initial: ['s3:GetObject', 's3:PutObjectLegalHold'] },
  parameters: { role: OrgRole.Admin },
};

/** An Admin opening an Owner's s3:* statement sees it checked and may clear it. */
export const AdminKeepsStoredAllActions: Story = {
  args: { initial: ['s3:*'] },
  parameters: { role: OrgRole.Admin },
};
