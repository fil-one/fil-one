import { useEffect, useRef } from 'react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole, S3Region } from '@filone/shared';
import { ToastProvider } from './Toast';
import { useAccessKeyForm } from '../lib/use-access-key-form.js';
import { AccessKeyFormFields } from './AccessKeyFormFields.js';
import { seedPermissions } from '../lib/test-permissions.js';

const mockSupportsIamMethods = vi.fn(() => false);
vi.mock('../lib/access-model.js', () => ({ supportsIamMethods: () => mockSupportsIamMethods() }));

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
  const PERSONAL_KEY_NOTE =
    "This key acts as you. What it can reach is decided by each bucket's policy.";

  beforeEach(() => mockSupportsIamMethods.mockReturnValue(true));
  afterEach(() => mockSupportsIamMethods.mockReturnValue(false));

  it('hides the permission and bucket fields for a personal key', async () => {
    renderForm(() => {});
    expect(await screen.findByText('Key name')).toBeInTheDocument();
    expect(screen.queryByText('What can this key do?')).not.toBeInTheDocument();
    expect(screen.queryByText('Which buckets can this key access?')).not.toBeInTheDocument();
  });

  it("explains that a personal key follows each bucket's policy", async () => {
    renderForm(() => {});
    expect(await screen.findByText(PERSONAL_KEY_NOTE)).toBeInTheDocument();
  });

  it.each([OrgRole.Owner, OrgRole.Admin])(
    'shows permission and bucket fields once %s picks Service key',
    async (role) => {
      renderForm(() => {}, role);
      fireEvent.click(await screen.findByLabelText(/Service key/));

      expect(await screen.findByText('What can this key do?')).toBeInTheDocument();
      expect(screen.getByText('Which buckets can this key access?')).toBeInTheDocument();
      expect(screen.queryByText(PERSONAL_KEY_NOTE)).not.toBeInTheDocument();
    },
  );

  it('hides the key-type choice from a Member', async () => {
    renderForm(() => {}, OrgRole.Member);
    expect(await screen.findByText(PERSONAL_KEY_NOTE)).toBeInTheDocument();
    expect(screen.queryByText('What kind of key?')).not.toBeInTheDocument();
  });
});
