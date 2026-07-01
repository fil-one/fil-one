import { useEffect, useRef } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { S3Region } from '@filone/shared';
import { ToastProvider } from './Toast';
import { useAccessKeyForm } from '../lib/use-access-key-form.js';
import { AccessKeyFormFields } from './AccessKeyFormFields.js';

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

function renderForm(apply: (form: ReturnType<typeof useAccessKeyForm>) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
