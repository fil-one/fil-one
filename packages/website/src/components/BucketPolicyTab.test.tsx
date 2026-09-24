import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiErrorCode, OrgRole } from '@filone/shared';
import type { BucketPolicy } from '@filone/shared';
import { S3Region } from '@filone/shared';

import { queryKeys } from '../lib/query-client.js';
import { seedPermissions } from '../lib/test-permissions.js';

const mockGet = vi.fn();
const mockPut = vi.fn();
const mockDelete = vi.fn();
vi.mock('../lib/bucket-policy-api.js', async () => ({
  ...(await vi.importActual<typeof import('../lib/bucket-policy-api.js')>(
    '../lib/bucket-policy-api.js',
  )),
  getBucketPolicy: (...a: unknown[]) => mockGet(...a),
  putBucketPolicy: (...a: unknown[]) => mockPut(...a),
  deleteBucketPolicy: (...a: unknown[]) => mockDelete(...a),
}));
vi.mock('../lib/access-model.js', () => ({ isIamRegion: () => true }));
vi.mock('../lib/api.js', async () => ({
  ...(await vi.importActual<typeof import('../lib/api.js')>('../lib/api.js')),
  getMe: vi.fn(() => new Promise(() => {})),
}));
vi.mock('../lib/members-api.js', () => ({
  listMembers: () =>
    Promise.resolve({
      members: [
        { userId: 'user-1', role: OrgRole.Owner, name: 'Ada' },
        { userId: 'user-2', role: OrgRole.Member, name: 'Ben' },
      ],
    }),
}));

import { BucketPolicyTab } from './BucketPolicyTab.js';
import { ToastProvider } from './Toast/ToastProvider.js';

const policy: BucketPolicy = {
  statement: [
    {
      sid: 'team',
      effect: 'allow',
      principal: ['user-2'],
      action: ['s3:GetObject', 's3:ListBucket'],
    },
  ],
};

function renderTab(role: OrgRole = OrgRole.Owner) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, role);
  const view = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <BucketPolicyTab bucketName="photos" region={S3Region.UsEast9} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

describe('BucketPolicyTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ policy, etag: '"v1"' });
    mockPut.mockResolvedValue({ etag: '"v2"', created: false });
  });

  it('shows the statements with their members named, once the policy loads', async () => {
    renderTab();

    expect(await screen.findByText('team')).toBeInTheDocument();
    expect(await screen.findByText('Ben')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove policy' })).toBeInTheDocument();
    expect(screen.queryByTestId('policy-save-bar')).not.toBeInTheDocument();
  });

  it('offers the first statement on a bucket with no policy', async () => {
    mockGet.mockResolvedValue(null);
    renderTab();

    expect(await screen.findByText('No policy yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove policy' })).not.toBeInTheDocument();
  });

  it('says a request failed rather than calling the bucket policy-less', async () => {
    mockGet.mockRejectedValue(new Error('Service unavailable'));
    renderTab();

    expect(await screen.findByText('Service unavailable')).toBeInTheDocument();
    expect(screen.queryByText('No policy yet')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('removes a statement into the draft and saves the document under the etag it read', async () => {
    renderTab();
    await screen.findByText('team');

    fireEvent.click(screen.getByRole('button', { name: 'Remove team' }));
    expect(await screen.findByText('This policy has no statements')).toBeInTheDocument();
    expect(screen.getByTestId('policy-save-bar')).toBeInTheDocument();

    // A draft with no statements removes the policy: the storage system holds no empty document.
    mockDelete.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));

    await waitFor(() =>
      expect(mockDelete).toHaveBeenCalledWith('photos', S3Region.UsEast9, '"v1"'),
    );
    await waitFor(() => expect(screen.queryByTestId('policy-save-bar')).not.toBeInTheDocument());
  });

  it('adds a statement through the modal and writes the whole document once', async () => {
    renderTab();
    await screen.findByText('team');

    fireEvent.click(screen.getByRole('button', { name: 'Add statement' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Everyone in this organization' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Read objects' }));
    fireEvent.click(
      within(screen.getByTestId('policy-statement-modal')).getByRole('button', {
        name: 'Add statement',
      }),
    );

    await waitFor(() => expect(screen.getAllByTestId('policy-statement')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));

    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    expect(mockPut).toHaveBeenCalledWith('photos', S3Region.UsEast9, {
      policy: {
        statement: [
          ...policy.statement,
          { effect: 'allow', principal: '*', action: ['s3:GetObject'] },
        ],
      },
      etag: '"v1"',
    });
    await waitFor(() => expect(screen.queryByTestId('policy-save-bar')).not.toBeInTheDocument());
  });

  it('keeps the draft and offers a reload when the save lost to another writer', async () => {
    mockPut.mockRejectedValue(
      Object.assign(new Error('changed'), { status: 409, code: ApiErrorCode.POLICY_CONFLICT }),
    );
    renderTab();
    await screen.findByText('team');

    fireEvent.click(screen.getByRole('button', { name: 'Remove team' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Add statement' })[0]!);
    fireEvent.click(await screen.findByRole('radio', { name: 'Everyone in this organization' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Read objects' }));
    fireEvent.click(
      within(screen.getByTestId('policy-statement-modal')).getByRole('button', {
        name: 'Add statement',
      }),
    );
    await waitFor(() => expect(screen.getAllByTestId('policy-statement')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));

    expect(await screen.findByText('This policy changed elsewhere')).toBeInTheDocument();
    // The draft is still the edited one.
    expect(
      within(screen.getByTestId('policy-statement')).getByText('Everyone in this organization'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('policy-save-bar')).toBeInTheDocument();

    mockGet.mockResolvedValue({ policy, etag: '"v2"' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reload policy' }));
    });
    await waitFor(() => expect(screen.getByText('team')).toBeInTheDocument());
    expect(screen.queryByText('This policy changed elsewhere')).not.toBeInTheDocument();
  });

  it('sends the etag the draft was read at, and stops saving once a newer document arrived', async () => {
    const { client } = renderTab();
    await screen.findByText('team');
    fireEvent.click(screen.getByRole('button', { name: 'Remove team' }));
    await screen.findByTestId('policy-save-bar');

    // Another writer landed and a background refetch picked it up.
    mockGet.mockResolvedValue({ policy, etag: '"v2"' });
    await act(async () => {
      await client.refetchQueries({ queryKey: queryKeys.bucketPolicy('photos', S3Region.UsEast9) });
    });

    expect(await screen.findByText('This policy changed elsewhere')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save policy' })).toBeDisabled();
    // The draft still shows the edit, and reloading takes the newer document.
    expect(screen.getByText('This policy has no statements')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reload policy' }));
    await waitFor(() => expect(screen.getByText('team')).toBeInTheDocument());
    expect(screen.queryByTestId('policy-save-bar')).not.toBeInTheDocument();
  });

  it('warns when a deny names everyone', async () => {
    mockGet.mockResolvedValue({
      policy: { statement: [{ effect: 'deny', principal: '*', action: ['s3:DeleteObject'] }] },
      etag: '"v1"',
    });
    renderTab();

    expect(await screen.findByText('This policy denies everyone')).toBeInTheDocument();
  });
});
