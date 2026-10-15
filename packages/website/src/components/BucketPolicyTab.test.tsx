import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiErrorCode, OrgRole } from '@filone/shared';
import type { BucketPolicy } from '@filone/shared';
import { S3Region } from '@filone/shared';

import { queryKeys } from '../lib/query-client.js';
import { seedPermissions } from '../lib/test-permissions.js';

const mockGetBucketPolicy = vi.fn();
const mockPutBucketPolicy = vi.fn();
const mockDeleteBucketPolicy = vi.fn();
vi.mock('../lib/bucket-policy-api.js', async () => ({
  ...(await vi.importActual<typeof import('../lib/bucket-policy-api.js')>(
    '../lib/bucket-policy-api.js',
  )),
  getBucketPolicy: (...a: unknown[]) => mockGetBucketPolicy(...a),
  putBucketPolicy: (...a: unknown[]) => mockPutBucketPolicy(...a),
  deleteBucketPolicy: (...a: unknown[]) => mockDeleteBucketPolicy(...a),
}));
vi.mock('../lib/access-model.js', () => ({ supportsIamMethods: () => true }));
vi.mock('../lib/api.js', async () => ({
  ...(await vi.importActual<typeof import('../lib/api.js')>('../lib/api.js')),
  getMe: vi.fn(() => new Promise(() => {})),
}));
vi.mock('../lib/members-api.js', () => ({
  listMembers: () =>
    Promise.resolve({
      members: [
        { userId: USER_1, role: OrgRole.Owner, name: 'Ada' },
        { userId: USER_2, role: OrgRole.Member, name: 'Ben' },
      ],
    }),
}));

import { BucketPolicyTab } from './BucketPolicyTab.js';
import { ToastProvider } from './Toast/ToastProvider.js';

const USER_1 = '00000000-0000-0000-0000-000000000001';
const USER_2 = '00000000-0000-0000-0000-000000000002';

const grantReadAndListToBen: BucketPolicy = {
  Statement: [
    {
      Sid: 'team',
      Effect: 'Allow',
      Principal: [USER_2],
      Action: ['s3:GetObject', 's3:ListBucket'],
    },
  ],
};

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, OrgRole.Owner);
  const view = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <BucketPolicyTab bucketName="photos" region={S3Region.UsEast9} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

function getEmptyState(title: string) {
  return screen.getByText(title).parentElement!;
}

async function removeTeamStatement() {
  await screen.findByText('team');
  fireEvent.click(screen.getByRole('button', { name: 'Actions for team' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Remove statement' }));
  await screen.findByTestId('policy-save-bar');
}

async function addEveryoneMayReadStatement(addButton: HTMLElement) {
  fireEvent.click(addButton);
  fireEvent.click(await screen.findByRole('radio', { name: 'Everyone in this organization' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Read objects' }));
  fireEvent.click(
    within(screen.getByTestId('policy-statement-modal')).getByRole('button', {
      name: 'Add statement',
    }),
  );
}

async function saveAndLoseToAnotherWriter() {
  mockPutBucketPolicy.mockRejectedValue(
    Object.assign(new Error('changed'), { status: 409, code: ApiErrorCode.POLICY_CONFLICT }),
  );
  await removeTeamStatement();
  await addEveryoneMayReadStatement(
    within(getEmptyState('This policy has no statements')).getByRole('button', {
      name: 'Add statement',
    }),
  );
  await waitFor(() => expect(screen.getAllByTestId('policy-statement')).toHaveLength(1));
  fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
  await screen.findByText('This policy changed elsewhere');
}

async function refetchNewerPolicy(client: QueryClient) {
  mockGetBucketPolicy.mockResolvedValue({ policy: grantReadAndListToBen, etag: '"v2"' });
  await act(async () => {
    await client.refetchQueries({ queryKey: queryKeys.bucketPolicy('photos', S3Region.UsEast9) });
  });
  await screen.findByText('This policy changed elsewhere');
}

async function confirmRemovePolicy() {
  await screen.findByText('team');
  fireEvent.click(screen.getByRole('button', { name: 'Remove policy' }));
  fireEvent.click(
    within(await screen.findByTestId('confirm-dialog')).getByRole('button', {
      name: 'Remove policy',
    }),
  );
}

describe('BucketPolicyTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBucketPolicy.mockResolvedValue({ policy: grantReadAndListToBen, etag: '"v1"' });
    mockPutBucketPolicy.mockResolvedValue({ etag: '"v2"', created: false });
    mockDeleteBucketPolicy.mockResolvedValue(undefined);
  });

  it('titles each statement by its Sid', async () => {
    renderTab();

    expect(await screen.findByText('team')).toBeInTheDocument();
  });

  it('names the members a statement grants', async () => {
    renderTab();

    expect(await screen.findByText('Ben')).toBeInTheDocument();
  });

  it('offers Remove policy when the bucket has a policy', async () => {
    renderTab();

    expect(await screen.findByRole('button', { name: 'Remove policy' })).toBeInTheDocument();
  });

  it('shows no save bar before any edit', async () => {
    renderTab();
    await screen.findByText('team');

    expect(screen.queryByTestId('policy-save-bar')).not.toBeInTheDocument();
  });

  it('shows the No policy yet empty state with an Add statement button when the bucket has no policy', async () => {
    mockGetBucketPolicy.mockResolvedValue(null);
    renderTab();

    await screen.findByText('No policy yet');
    expect(
      within(getEmptyState('No policy yet')).getByRole('button', { name: 'Add statement' }),
    ).toBeInTheDocument();
  });

  it('hides Remove policy when the bucket has no policy', async () => {
    mockGetBucketPolicy.mockResolvedValue(null);
    renderTab();
    await screen.findByText('No policy yet');

    expect(screen.queryByRole('button', { name: 'Remove policy' })).not.toBeInTheDocument();
  });

  it('shows the load error and Try again when reading the policy fails', async () => {
    mockGetBucketPolicy.mockRejectedValue(new Error('Service unavailable'));
    renderTab();

    expect(await screen.findByText('Service unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText('No policy yet')).not.toBeInTheDocument();
  });

  it('Try again re-reads the policy', async () => {
    mockGetBucketPolicy.mockRejectedValueOnce(new Error('Service unavailable'));
    renderTab();

    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('team')).toBeInTheDocument();
    expect(mockGetBucketPolicy).toHaveBeenCalledTimes(2);
  });

  it('shows the save bar and the no-statements state after removing the last statement', async () => {
    renderTab();
    await removeTeamStatement();

    expect(screen.getByTestId('policy-save-bar')).toBeInTheDocument();
    expect(screen.getByText('This policy has no statements')).toBeInTheDocument();
  });

  it('deletes the policy under the ETag it read when an empty draft is saved', async () => {
    renderTab();
    await removeTeamStatement();

    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));

    expect(await screen.findByText('Policy removed')).toBeInTheDocument();
    expect(mockDeleteBucketPolicy).toHaveBeenCalledWith('photos', S3Region.UsEast9, '"v1"');
    expect(mockPutBucketPolicy).not.toHaveBeenCalled();
  });

  it('replaces an edited statement in place', async () => {
    renderTab();
    await screen.findByText('team');

    fireEvent.click(screen.getByRole('button', { name: 'Actions for team' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit statement' }));
    const modal = await screen.findByTestId('policy-statement-modal');
    fireEvent.change(within(modal).getByLabelText('Name (optional)'), {
      target: { value: 'crew' },
    });
    fireEvent.click(within(modal).getByRole('button', { name: 'Save statement' }));

    await screen.findByText('crew');
    expect(screen.queryByText('team')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('policy-statement')).toHaveLength(1);
    expect(screen.getByTestId('policy-save-bar')).toBeInTheDocument();
  });

  it('shows an error when the stored policy carries no ETag to remove it under', async () => {
    mockGetBucketPolicy.mockResolvedValue({ policy: grantReadAndListToBen, etag: '' });
    renderTab();

    await confirmRemovePolicy();

    expect(
      await screen.findByText('The policy has no ETag to remove it under'),
    ).toBeInTheDocument();
    expect(mockDeleteBucketPolicy).not.toHaveBeenCalled();
  });

  it('adds the new statement as a card', async () => {
    renderTab();
    await screen.findByText('team');

    await addEveryoneMayReadStatement(screen.getByRole('button', { name: 'Add statement' }));

    await waitFor(() => expect(screen.getAllByTestId('policy-statement')).toHaveLength(2));
  });

  it('saves the whole document under the ETag it read', async () => {
    renderTab();
    await screen.findByText('team');
    await addEveryoneMayReadStatement(screen.getByRole('button', { name: 'Add statement' }));
    await waitFor(() => expect(screen.getAllByTestId('policy-statement')).toHaveLength(2));

    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));

    expect(await screen.findByText('Policy saved')).toBeInTheDocument();
    expect(mockPutBucketPolicy.mock.calls).toStrictEqual([
      [
        'photos',
        S3Region.UsEast9,
        {
          policy: {
            Statement: [
              ...grantReadAndListToBen.Statement,
              { Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'] },
            ],
          },
          etag: '"v1"',
        },
      ],
    ]);
  });

  it('keeps the edited draft when the save is refused as a conflict', async () => {
    renderTab();
    await saveAndLoseToAnotherWriter();

    expect(
      within(screen.getByTestId('policy-statement')).getByText('Everyone in this organization'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('policy-save-bar')).toBeInTheDocument();
  });

  it('Reload policy replaces the draft with the stored policy', async () => {
    renderTab();
    await saveAndLoseToAnotherWriter();

    mockGetBucketPolicy.mockResolvedValue({ policy: grantReadAndListToBen, etag: '"v2"' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reload policy' }));
    });

    await waitFor(() => expect(screen.getByText('team')).toBeInTheDocument());
    expect(screen.queryByText('This policy changed elsewhere')).not.toBeInTheDocument();
    expect(screen.queryByTestId('policy-save-bar')).not.toBeInTheDocument();
  });

  it('disables Save policy once a newer policy arrives under unsaved edits', async () => {
    const { client } = renderTab();
    await removeTeamStatement();

    await refetchNewerPolicy(client);

    expect(screen.getByRole('button', { name: 'Save policy' })).toBeDisabled();
  });

  it('keeps the draft and the conflict alert when Reload policy fails', async () => {
    const { client } = renderTab();
    await removeTeamStatement();
    await refetchNewerPolicy(client);

    mockGetBucketPolicy.mockRejectedValue(new Error('Service unavailable'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reload policy' }));
    });

    expect(await screen.findByText('Could not reload the policy. Try again.')).toBeInTheDocument();
    expect(screen.getByText('This policy changed elsewhere')).toBeInTheDocument();
    expect(screen.getByText('This policy has no statements')).toBeInTheDocument();
  });

  it('disables Remove policy while the draft is stale', async () => {
    const { client } = renderTab();
    await removeTeamStatement();

    await refetchNewerPolicy(client);

    expect(screen.getByRole('button', { name: 'Remove policy' })).toBeDisabled();
  });

  it('deletes under the ETag the draft was read at even after a newer policy arrives', async () => {
    const { client } = renderTab();
    await removeTeamStatement();
    fireEvent.click(screen.getByRole('button', { name: 'Remove policy' }));
    const dialog = await screen.findByTestId('confirm-dialog');

    await refetchNewerPolicy(client);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove policy' }));

    await waitFor(() =>
      expect(mockDeleteBucketPolicy).toHaveBeenCalledWith('photos', S3Region.UsEast9, '"v1"'),
    );
  });

  it('deletes the policy under the ETag it read', async () => {
    renderTab();

    await confirmRemovePolicy();

    await waitFor(() =>
      expect(mockDeleteBucketPolicy).toHaveBeenCalledWith('photos', S3Region.UsEast9, '"v1"'),
    );
  });

  it('shows the error and keeps the statements when removal fails', async () => {
    mockDeleteBucketPolicy.mockRejectedValue(new Error('Service unavailable'));
    renderTab();

    await confirmRemovePolicy();

    expect(await screen.findByText('Service unavailable')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument());
    expect(screen.getByText('team')).toBeInTheDocument();
  });

  it('warns when a Deny statement applies to everyone', async () => {
    mockGetBucketPolicy.mockResolvedValue({
      policy: { Statement: [{ Effect: 'Deny', Principal: '*', Action: ['s3:DeleteObject'] }] },
      etag: '"v1"',
    });
    renderTab();

    expect(await screen.findByText('This policy denies everyone')).toBeInTheDocument();
  });

  it('does not warn for a Deny that names members', async () => {
    mockGetBucketPolicy.mockResolvedValue({
      policy: {
        Statement: [{ Effect: 'Deny', Principal: [USER_2], Action: ['s3:DeleteObject'] }],
      },
      etag: '"v1"',
    });
    renderTab();
    await screen.findByText('Ben');

    expect(screen.queryByText('This policy denies everyone')).not.toBeInTheDocument();
  });
});
