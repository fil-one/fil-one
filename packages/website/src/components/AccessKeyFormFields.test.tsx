import { useEffect, useRef } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole, S3Region } from '@filone/shared';
import { ToastProvider } from './Toast';
import { useAccessKeyForm } from '../lib/use-access-key-form.js';
import { AccessKeyFormFields } from './AccessKeyFormFields.js';
import { seedPermissions } from '../lib/test-permissions.js';

const mockIsIam = vi.fn(() => false);
vi.mock('../lib/access-model.js', () => ({ isIamRegion: () => mockIsIam() }));

function Harness({ apply }: { apply: (form: ReturnType<typeof useAccessKeyForm>) => void }) {
  const form = useAccessKeyForm({ region: S3Region.UsEast1, onSuccess: () => {} });
  const applied = useRef(false);
  useEffect(() => {
    if (applied.current) return;
    applied.current = true;
    apply(form);
  }, [apply, form]);
  return <AccessKeyFormFields form={form} region={S3Region.UsEast1} />;
}

function renderForm(
  apply: (form: ReturnType<typeof useAccessKeyForm>) => void,
  role: OrgRole = OrgRole.Owner,
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The permission checkboxes are filtered by what the caller's role can grant,
  // so the role has to be in the cache before the form renders.
  seedPermissions(qc, role);
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <Harness apply={apply} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('AccessKeyFormFields — permissions error', () => {
  it('shows the error when no permission is selected', async () => {
    renderForm((form) => form.setPermissions([]));
    expect(await screen.findByText('Select at least one permission.')).toBeInTheDocument();
  });

  it('hides the error when only a bucket-management permission is selected', async () => {
    renderForm((form) => form.setPermissions(['CreateBucket']));
    // Wait for the permissions state to flush, then confirm no error remains.
    await screen.findByTestId('permission-CreateBucket');
    expect(screen.queryByText('Select at least one permission.')).not.toBeInTheDocument();
  });
});

describe('AccessKeyFormFields — reserved key name', () => {
  it('shows the error when the name starts with the reserved prefix', async () => {
    renderForm((form) => form.setKeyName('filone-console-v2'));
    expect(
      await screen.findByText('Names starting with "filone-console" are reserved for FilOne.'),
    ).toBeInTheDocument();
  });
});

describe('AccessKeyFormFields — on a region serving the iam access model', () => {
  it('asks for no permissions or bucket scope, and says what the key follows instead', async () => {
    mockIsIam.mockReturnValue(true);
    try {
      renderForm(() => {});
      expect(
        await screen.findByText(
          "This key acts as you. What it can reach is decided by each bucket's policy.",
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText('What can this key do?')).not.toBeInTheDocument();
      expect(screen.queryByText('Which buckets can this key access?')).not.toBeInTheDocument();
      expect(screen.getByText('Key name')).toBeInTheDocument();
    } finally {
      mockIsIam.mockReturnValue(false);
    }
  });

  it('lets an Owner choose a service key, which asks for permissions and bucket scope', async () => {
    mockIsIam.mockReturnValue(true);
    try {
      renderForm(() => {});
      fireEvent.click(await screen.findByLabelText(/Service key/));

      expect(await screen.findByText('What can this key do?')).toBeInTheDocument();
      expect(screen.getByText('Which buckets can this key access?')).toBeInTheDocument();
      expect(
        screen.queryByText(
          "This key acts as you. What it can reach is decided by each bucket's policy.",
        ),
      ).not.toBeInTheDocument();
    } finally {
      mockIsIam.mockReturnValue(false);
    }
  });

  it('offers a Member no choice: their key follows the policies', async () => {
    mockIsIam.mockReturnValue(true);
    try {
      renderForm(() => {}, OrgRole.Member);
      expect(
        await screen.findByText(
          "This key acts as you. What it can reach is decided by each bucket's policy.",
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText('What kind of key?')).not.toBeInTheDocument();
    } finally {
      mockIsIam.mockReturnValue(false);
    }
  });
});
