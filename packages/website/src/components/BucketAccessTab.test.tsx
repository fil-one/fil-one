import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole, S3Region } from '@filone/shared';
import type { AccessKey } from '@filone/shared';

vi.mock('../lib/api.js', () => ({
  apiRequest: vi.fn(),
  getMe: vi.fn(() => new Promise(() => {})),
}));

import { BucketAccessTab } from './BucketAccessTab.js';
import { ToastProvider } from './Toast/ToastProvider.js';
import { seedPermissions } from '../lib/test-permissions.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function key(over: Partial<AccessKey> = {}): AccessKey {
  return {
    id: 'key-1',
    keyName: 'my key',
    accessKeyId: 'ACCESS_KEY_12345EXAMPL',
    createdAt: '2026-01-15T10:00:00Z',
    status: 'active',
    permissions: ['read', 'list'],
    bucketScope: 'specific',
    buckets: ['my-bucket'],
    region: S3Region.UsEast1,
    // `seedPermissions` writes userId 'user-1'.
    createdBy: 'user-1',
    ...over,
  };
}

function renderTab(
  props: Partial<React.ComponentProps<typeof BucketAccessTab>> = {},
  role: OrgRole = OrgRole.Owner,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, role);
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <BucketAccessTab
          bucketName="my-bucket"
          s3Endpoint="https://s3.example.org"
          region={S3Region.UsEast1}
          accessKeys={[]}
          accessKeysLoading={false}
          onCreateOpen={() => {}}
          {...props}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BucketAccessTab — the keys list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('says a request failed rather than calling the bucket empty', () => {
    // "No access keys yet" over a failed request is a claim about the bucket,
    // and it came with a Create button under it.
    renderTab({ accessKeysError: true, accessKeysErrorMessage: 'Service unavailable' });

    expect(screen.getByText('Service unavailable')).toBeInTheDocument();
    expect(screen.queryByText('No access keys yet')).not.toBeInTheDocument();
  });

  it('keeps the empty state for an empty bucket', () => {
    renderTab();

    expect(screen.getByText('No access keys yet')).toBeInTheDocument();
  });

  it('drops the invitation to create for a role that cannot', () => {
    renderTab({}, OrgRole.ReadOnly);

    expect(screen.getByText('Keys with access to this bucket appear here')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create your first key/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add key' })).not.toBeInTheDocument();
  });
});

describe('BucketAccessTab — who may revoke', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gives a Member the action on the key they minted', () => {
    renderTab({ accessKeys: [key()] }, OrgRole.Member);

    expect(screen.getByRole('button', { name: 'Key actions' })).toBeInTheDocument();
  });

  it('withholds it on a key somebody else minted', () => {
    renderTab({ accessKeys: [key({ createdBy: 'user-2' })] }, OrgRole.Member);

    expect(screen.queryByRole('button', { name: 'Key actions' })).not.toBeInTheDocument();
  });

  it('gives an Admin the action on every key', () => {
    renderTab({ accessKeys: [key(), key({ id: 'key-2', createdBy: 'user-2' })] }, OrgRole.Admin);

    expect(screen.getAllByRole('button', { name: 'Key actions' })).toHaveLength(2);
  });

  it('gives ReadOnly none', () => {
    renderTab({ accessKeys: [key()] }, OrgRole.ReadOnly);

    expect(screen.queryByRole('button', { name: 'Key actions' })).not.toBeInTheDocument();
  });
});
