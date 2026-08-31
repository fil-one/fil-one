import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  OrgRole,
  S3Region,
  type AccessKeyPermission,
  type GranularPermission,
} from '@filone/shared';

vi.mock('../lib/api.js', () => ({ getMe: vi.fn(() => new Promise(() => {})) }));

import { AccessKeyPermissionsFields } from './AccessKeyPermissionsFields.js';
import { seedPermissions } from '../lib/test-permissions.js';

function Harness({
  region,
  initialPermissions = [],
}: {
  region: S3Region;
  initialPermissions?: AccessKeyPermission[];
}) {
  const [value, setValue] = useState<AccessKeyPermission[]>(initialPermissions);
  const [granular, setGranular] = useState<GranularPermission[]>([]);
  return (
    <>
      <AccessKeyPermissionsFields
        value={value}
        onChange={setValue}
        granularPermissions={granular}
        onGranularPermissionsChange={setGranular}
        region={region}
      />
      {/* What would be submitted, which the rendered rows do not show once a
          permission is dropped from the offer. */}
      <div data-testid="selected">{value.join(' ')}</div>
      <div data-testid="selected-granular">{granular.join(' ')}</div>
    </>
  );
}

/**
 * The form offers only what the caller's role can grant, so the role has to be
 * seeded before it renders. Owner unless a test is about a narrower one.
 *
 * The client comes back so a test can re-seed it mid-render, which is what a
 * role change under an open form looks like.
 */
function renderFields(
  region: S3Region,
  role: OrgRole | undefined = OrgRole.Owner,
  initialPermissions?: AccessKeyPermission[],
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (role !== undefined) seedPermissions(client, role);
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <Harness region={region} initialPermissions={initialPermissions} />
      </QueryClientProvider>,
    ),
  };
}

describe('AccessKeyPermissionsFields — bucket-info permissions', () => {
  it('renders the bucket versioning permission checkbox', () => {
    renderFields(S3Region.UsEast1);
    expect(screen.getByTestId('permission-GetBucketVersioning')).toBeInTheDocument();
  });

  it('renders the object lock configuration permission checkbox', () => {
    renderFields(S3Region.UsEast1);
    expect(screen.getByTestId('permission-GetBucketObjectLockConfiguration')).toBeInTheDocument();
  });

  it('keeps bucket-info permissions enabled in the Aurora region', () => {
    renderFields(S3Region.EuWest1);
    const checkbox = screen.getByRole('checkbox', { name: 'Read bucket versioning' });
    expect(checkbox).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('disables bucket-management permissions in the Aurora region', () => {
    renderFields(S3Region.EuWest1);
    const checkbox = screen.getByRole('checkbox', { name: 'Create bucket' });
    expect(checkbox).toHaveAttribute('aria-disabled', 'true');
  });

  it('selects a bucket-info permission when its checkbox is toggled', () => {
    renderFields(S3Region.EuWest1);
    const checkbox = screen.getByRole('checkbox', { name: 'Read bucket versioning' });
    fireEvent.click(checkbox);
    expect(checkbox).toHaveAttribute('aria-checked', 'true');
  });
});

// ---------------------------------------------------------------------------
// The creator-authority cap, as the form sees it
// ---------------------------------------------------------------------------

describe('AccessKeyPermissionsFields — what a role may grant', () => {
  it('offers a Member the bucket permissions they hold and not the ones they do not', () => {
    // A Member holds `buckets.create` and not `buckets.delete`, so a key they
    // mint can create buckets and not delete them. Offering Delete Bucket would
    // build a form whose only outcome is a 403.
    renderFields(S3Region.UsEast1, OrgRole.Member);

    expect(screen.getByTestId('permission-CreateBucket')).toBeInTheDocument();
    expect(screen.queryByTestId('permission-DeleteBucket')).not.toBeInTheDocument();
  });

  it('offers ReadOnly the object permissions they hold and not the ones they do not', () => {
    renderFields(S3Region.UsEast1, OrgRole.ReadOnly);

    expect(screen.getByTestId('permission-read')).toBeInTheDocument();
    expect(screen.getByTestId('permission-list')).toBeInTheDocument();
    expect(screen.queryByTestId('permission-write')).not.toBeInTheDocument();
    expect(screen.queryByTestId('permission-delete')).not.toBeInTheDocument();
  });

  it('keeps the retention granulars to a role holding privileged.grant', () => {
    // Writing retention is redeemed at the vendor where its use cannot be
    // logged, and can make an object undeletable for years.
    renderFields(S3Region.UsEast1, OrgRole.Admin);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Write' }));

    expect(screen.queryByTestId('granular-permission-PutObjectRetention')).not.toBeInTheDocument();
    expect(screen.queryByTestId('granular-permission-PutObjectLegalHold')).not.toBeInTheDocument();
  });

  it('offers the retention granulars to an Owner', () => {
    renderFields(S3Region.UsEast1, OrgRole.Owner);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Write' }));

    expect(screen.getByTestId('granular-permission-PutObjectRetention')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// A role that narrows while the form is open
// ---------------------------------------------------------------------------

describe('AccessKeyPermissionsFields — a demotion under an open form', () => {
  it('drops a selected permission the caller may no longer grant', async () => {
    // Checked as an Owner, then demoted to Member: hiding the row leaves the
    // choice in the form's state, and submitting it earns a 403 naming a
    // permission that is no longer on screen.
    const { client } = renderFields(S3Region.UsEast1, OrgRole.Owner);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Create bucket' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Delete bucket' }));
    expect(screen.getByTestId('selected')).toHaveTextContent('DeleteBucket');

    seedPermissions(client, OrgRole.Member);

    // A Member keeps `buckets.create`, so Create Bucket is still selected and
    // only the one they can no longer grant goes.
    await waitFor(() => expect(screen.getByTestId('selected')).toHaveTextContent(/^CreateBucket$/));
    expect(screen.queryByTestId('permission-DeleteBucket')).not.toBeInTheDocument();
  });

  it('drops a selected granular the caller may no longer grant', async () => {
    const { client } = renderFields(S3Region.UsEast1, OrgRole.Owner);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Write' }));
    fireEvent.click(
      within(screen.getByTestId('granular-permission-PutObjectRetention')).getByRole('checkbox'),
    );
    expect(screen.getByTestId('selected-granular')).toHaveTextContent('PutObjectRetention');

    // Admin holds `objects.write` and not `privileged.grant`, so Write stays
    // and only the elevated granular goes.
    seedPermissions(client, OrgRole.Admin);

    await waitFor(() => expect(screen.getByTestId('selected-granular')).toBeEmptyDOMElement());
    expect(screen.getByTestId('selected')).toHaveTextContent('write');
  });

  it('leaves the selection alone while the role is still unknown', () => {
    // `has()` grants nothing until `/me` answers. Pruning on that would clear
    // the form's default permissions on mount, and nothing would restore them.
    renderFields(S3Region.UsEast1, undefined, ['read', 'write', 'list']);

    expect(screen.getByTestId('selected')).toHaveTextContent('read write list');
  });
});
