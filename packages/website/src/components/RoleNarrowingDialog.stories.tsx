import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';
import { S3Region, type AccessKeySummary } from '@filone/shared';

import { Button } from './Button';
import { RoleNarrowingDialog } from './RoleNarrowingDialog';

const meta: Meta<typeof RoleNarrowingDialog> = {
  title: 'Components/RoleNarrowingDialog',
  component: RoleNarrowingDialog,
};

export default meta;
type Story = StoryObj<typeof RoleNarrowingDialog>;

const KEYS: AccessKeySummary[] = [
  {
    id: 'key-1',
    keyName: 'nightly backup',
    accessKeyIdSuffix: '9f2a',
    region: S3Region.UsEast1,
    createdAt: '2026-02-01T00:00:00.000Z',
    reason: 'exceeds_role',
    excess: ['DeleteBucket'],
  },
  {
    id: 'key-2',
    keyName: 'compliance writer',
    accessKeyIdSuffix: 'c410',
    region: S3Region.EuWest1,
    createdAt: '2026-05-14T00:00:00.000Z',
    reason: 'exceeds_role',
    excess: ['PutObjectRetention', 'PutObjectLegalHold'],
  },
];

function Harness(props: Partial<React.ComponentProps<typeof RoleNarrowingDialog>>) {
  const [open, setOpen] = useState(true);
  return (
    <>
      {!open && (
        <Button variant="primary" onClick={() => setOpen(true)}>
          Open dialog
        </Button>
      )}
      <RoleNarrowingDialog
        open={open}
        memberName="Grace Hopper"
        fromRole="Admin"
        toRole="Member"
        keys={[]}
        survivingCount={0}
        unattributedCount={0}
        onClose={() => setOpen(false)}
        onConfirm={() => setOpen(false)}
        {...props}
      />
    </>
  );
}

export const KeysToRevoke: Story = {
  render: () => <Harness keys={KEYS} survivingCount={3} unattributedCount={2} />,
};

export const NothingToRevoke: Story = {
  render: () => <Harness />,
};

export const OwnRole: Story = {
  render: () => (
    <Harness
      self
      fromRole="Owner"
      toRole="Admin"
      note="You go from Owner to Admin in this organization. Billing and the organization itself go with the owner seat, and only an owner can hand it back."
      keys={KEYS.slice(1)}
      survivingCount={1}
      unattributedCount={0}
    />
  ),
};

export const Loading: Story = {
  render: () => <Harness keys={undefined} loading />,
};

export const PreviewUnavailable: Story = {
  render: () => <Harness keys={undefined} error />,
};
