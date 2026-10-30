import type { Meta, StoryObj } from '@storybook/react-vite';
import { POLICY_VERSION, S3Region, buildStatement } from '@filone/shared';
import type { BucketPolicy, PolicyStatement } from '@filone/shared';

import type { BucketPolicySnapshot } from '../lib/bucket-policy-api';
import { queryKeys } from '../lib/query-client';
import { ADA_ID, BEN_ID, storyRoster, withMembers, withQueryData } from '../lib/story-members';
import { BucketPolicyTab, LoadedPolicyView } from './BucketPolicyTab';
import type { LoadedPolicyEditor } from './BucketPolicyTab';

const BUCKET = 'photos';
const REGION = S3Region.UsEast9;

const teamReads: PolicyStatement = buildStatement({
  bucketName: BUCKET,
  principal: [ADA_ID, BEN_ID],
  actions: ['s3:GetObject', 's3:ListBucket'],
  sid: 'team',
});
const everyoneReads: PolicyStatement = buildStatement({
  bucketName: BUCKET,
  principal: '*',
  actions: ['s3:GetObject'],
  sid: 'everyone',
});
const nobodyDeletes: PolicyStatement = buildStatement({
  bucketName: BUCKET,
  effect: 'Deny',
  principal: [BEN_ID],
  actions: ['s3:DeleteObject'],
  sid: 'no-deletes',
});
const storedPolicy: BucketPolicy = {
  Version: POLICY_VERSION,
  Statement: [teamReads, everyoneReads, nobodyDeletes],
};
const storedSnapshot: BucketPolicySnapshot = { policy: storedPolicy };

/** Seeds the stored policy the tab reads. */
function withPolicy(snapshot: BucketPolicySnapshot | null) {
  return withQueryData(queryKeys.bucketPolicy(BUCKET, REGION), snapshot);
}

const meta: Meta<typeof BucketPolicyTab> = {
  title: 'Components/BucketPolicyTab',
  component: BucketPolicyTab,
  args: { bucketName: BUCKET, region: REGION },
  decorators: [withMembers(storyRoster)],
};

export default meta;
type Story = StoryObj<typeof BucketPolicyTab>;

/** A stored policy: an Allow to named members, an Allow to everyone, and a Deny. */
export const Default: Story = {
  decorators: [withPolicy(storedSnapshot)],
};

export const NoPolicyYet: Story = {
  decorators: [withPolicy(null)],
};

export const DenyEveryone: Story = {
  decorators: [
    withPolicy({
      policy: {
        Version: POLICY_VERSION,
        Statement: [
          buildStatement({
            bucketName: BUCKET,
            effect: 'Deny',
            principal: '*',
            actions: ['s3:*'],
            sid: 'lockdown',
          }),
        ],
      },
    }),
  ],
};

/**
 * The states the hooks reach only after a user action or a request are shown
 * through the loaded view with a stubbed editor.
 */
function stubEditor(
  overrides: Partial<LoadedPolicyEditor['policy']> & Partial<LoadedPolicyEditor['draft']>,
): LoadedPolicyEditor {
  return {
    policy: {
      snapshot: storedSnapshot,
      isWriting: overrides.isWriting ?? false,
    },
    draft: {
      statements: overrides.statements ?? storedPolicy.Statement,
      hasUnsavedEdits: overrides.hasUnsavedEdits ?? false,
      reset: () => {},
      setStatements: () => {},
    },
    savePolicy: async () => {},
  };
}

function LoadedView({ editor }: { editor: LoadedPolicyEditor }) {
  const names: Record<string, string> = Object.fromEntries(
    storyRoster.map((member) => [member.userId, member.name ?? member.email ?? member.userId]),
  );
  return (
    <LoadedPolicyView
      editor={editor}
      getMemberName={(userId) => names[userId]}
      onAdd={() => {}}
      onEdit={() => {}}
    />
  );
}

export const UnsavedChanges: Story = {
  render: () => <LoadedView editor={stubEditor({ hasUnsavedEdits: true })} />,
};

export const Saving: Story = {
  render: () => <LoadedView editor={stubEditor({ hasUnsavedEdits: true, isWriting: true })} />,
};
