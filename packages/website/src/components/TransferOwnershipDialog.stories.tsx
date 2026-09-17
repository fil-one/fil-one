import type { Meta, StoryObj } from '@storybook/react-vite';
import { S3Region, type AccessKeySummary } from '@filone/shared';

import { TransferOwnershipDialog } from './TransferOwnershipDialog';

const meta: Meta<typeof TransferOwnershipDialog> = {
  title: 'Components/TransferOwnershipDialog',
  component: TransferOwnershipDialog,
  args: {
    open: true,
    orgName: 'Acme',
    memberName: 'grace@example.com',
    onClose: () => {},
    onConfirm: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof TransferOwnershipDialog>;

/**
 * The caller's own keys, as the preview forecasts them. `privileged.grant` is
 * what an Admin does not hold, so a key carrying object-lock permissions cannot
 * survive the seat moving.
 */
const KEYS: AccessKeySummary[] = [
  {
    id: 'key-1',
    keyName: 'compliance writer',
    accessKeyIdSuffix: 'c410',
    region: S3Region.EuWest1,
    createdAt: '2026-05-14T00:00:00.000Z',
    reason: 'exceeds_role',
    excess: ['PutObjectRetention', 'PutObjectLegalHold'],
  },
  {
    id: 'key-2',
    keyName: 'nightly backup',
    accessKeyIdSuffix: '9f2a',
    region: S3Region.UsEast1,
    createdAt: '2026-02-01T00:00:00.000Z',
    reason: 'exceeds_role',
    excess: ['DeleteBucket'],
  },
];

/**
 * The confirm stays inert until the organization's name is typed. This is the
 * one console action that takes away the caller's own authority and has no undo
 * they hold themselves.
 */
export const Default: Story = {};

/** The transfer is in flight, and the dialog cannot be dismissed out from under it. */
export const Transferring: Story = {
  args: { pending: true },
};

/** A member with no name on their profile row is named by their address. */
export const LongOrgName: Story = {
  args: { orgName: 'Contoso Manufacturing International', memberName: 'user-8f21c3' },
};

/**
 * One key, named. The singular copy, since a caller holding a single key should
 * not be told about "1 keys".
 */
export const KeysToRevoke: Story = {
  args: { affectedKeys: KEYS.slice(0, 1) },
};

/** More than one, counted and listed. */
export const SeveralKeysToRevoke: Story = {
  args: { affectedKeys: KEYS },
};

/**
 * The preview answered, and the answer was nothing. No alert at all: an Owner
 * whose keys an Admin could hold loses none of them, and inventing a
 * reassurance here would make the alert above read as routine.
 */
export const NothingToRevoke: Story = {
  args: { affectedKeys: [] },
};

/**
 * Waiting on the preview. The confirm is held even once the name is typed — a
 * dialog added to disclose what a transfer revokes must not be confirmable
 * before it has.
 */
export const Loading: Story = {
  args: { previewLoading: true },
};

/**
 * The preview could not be read. Unlike loading, the confirm is still reachable:
 * the transfer revokes what it must either way, and a preview outage is not a
 * reason to strand an Owner who needs to hand over the seat.
 */
export const PreviewUnavailable: Story = {
  args: { previewError: true },
};
