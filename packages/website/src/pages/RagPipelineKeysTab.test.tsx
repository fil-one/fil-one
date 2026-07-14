import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { S3Region } from '@filone/shared';
import type { RagApiKey } from '@filone/shared';

import { ToastProvider } from '../components/Toast/ToastProvider.js';
import { RagApiKeysTab } from './RagPipelineKeysTab.js';
import type { RagBucket } from '../lib/rag-bucket-api.js';

// ---------------------------------------------------------------------------
// Mocks — API client boundary
// ---------------------------------------------------------------------------

const mockList = vi.fn();
const mockCreate = vi.fn();
const mockDelete = vi.fn();

vi.mock('../lib/rag-api-keys-api.js', () => ({
  listRagApiKeys: (...args: unknown[]) => mockList(...args),
  createRagApiKey: (...args: unknown[]) => mockCreate(...args),
  deleteRagApiKey: (...args: unknown[]) => mockDelete(...args),
}));

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const TOKEN = 'sk_rag_0123456789abcdefghijklmnopqrstuvwxyzABCDEF';

const KEY: RagApiKey = {
  id: 'key-1',
  keyName: 'ci key',
  keyPrefix: 'sk_rag_AbC12',
  bucketScope: 'all',
  createdAt: '2026-07-01T00:00:00Z',
};

function bucket(over: Partial<RagBucket> = {}): RagBucket {
  return {
    name: 'my-bucket',
    region: S3Region.EuWest1,
    enabled: true,
    filesIndexed: 0,
    indexSize: 0,
    ...over,
  };
}

function renderTab(buckets: RagBucket[] = [bucket()]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <RagApiKeysTab buckets={buckets} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RagApiKeysTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue({ keys: [] });
  });

  it('renders key rows with prefix, scope, and last-used fallback', async () => {
    mockList.mockResolvedValue({
      keys: [
        KEY,
        {
          ...KEY,
          id: 'key-2',
          keyName: 'scoped key',
          bucketScope: 'specific',
          buckets: [{ region: S3Region.EuWest1, name: 'docs' }],
          lastUsedAt: '2026-07-05T00:00:00Z',
        },
      ],
    });

    renderTab();

    expect(await screen.findByText('ci key')).toBeInTheDocument();
    expect(screen.getAllByText('sk_rag_AbC12…')).toHaveLength(2);
    expect(screen.getByText('All buckets')).toBeInTheDocument();
    expect(screen.getByText('docs')).toBeInTheDocument();
    expect(screen.getByText('Never')).toBeInTheDocument();
  });

  it('shows an empty state when the org has no keys', async () => {
    renderTab();
    expect(await screen.findByTestId('rag-api-keys-empty')).toBeInTheDocument();
  });

  it('creates a key and reveals the token exactly once', async () => {
    mockCreate.mockResolvedValue({
      id: 'key-9',
      keyName: 'new key',
      keyPrefix: TOKEN.slice(0, 12),
      token: TOKEN,
      bucketScope: 'all',
      createdAt: '2026-07-10T00:00:00Z',
    });

    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Create API key/ }));

    fireEvent.change(screen.getByLabelText('Key name'), { target: { value: 'new key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith({ keyName: 'new key', bucketScope: 'all' }),
    );

    // Shown-once modal: token masked until revealed.
    const tokenField = await screen.findByTestId('rag-key-token');
    expect(tokenField).not.toHaveTextContent(TOKEN);
    fireEvent.click(screen.getByRole('button', { name: 'Show API key' }));
    expect(screen.getByTestId('rag-key-token')).toHaveTextContent(TOKEN);

    // Dismissing the modal removes the token from the DOM for good.
    fireEvent.click(screen.getByRole('button', { name: "I've saved this key" }));
    await waitFor(() => expect(screen.queryByTestId('rag-key-token')).not.toBeInTheDocument());
  });

  it('scopes a key to selected RAG-enabled buckets as (region, name) pairs', async () => {
    mockCreate.mockResolvedValue({
      id: 'key-9',
      keyName: 'scoped',
      keyPrefix: TOKEN.slice(0, 12),
      token: TOKEN,
      bucketScope: 'specific',
      buckets: [{ region: S3Region.EuWest1, name: 'enabled-bucket' }],
      createdAt: '2026-07-10T00:00:00Z',
    });
    renderTab([
      bucket({ name: 'enabled-bucket' }),
      bucket({ name: 'disabled-bucket', enabled: false }),
    ]);

    fireEvent.click(await screen.findByRole('button', { name: /Create API key/ }));
    fireEvent.change(screen.getByLabelText('Key name'), { target: { value: 'scoped' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Specific buckets' }));

    // Only RAG-enabled buckets are offered.
    expect(screen.getByLabelText('enabled-bucket')).toBeInTheDocument();
    expect(screen.queryByLabelText('disabled-bucket')).not.toBeInTheDocument();

    // Nothing selected yet — submit stays disabled.
    expect(screen.getByRole('button', { name: 'Create key' })).toBeDisabled();

    fireEvent.click(screen.getByLabelText('enabled-bucket'));
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith({
        keyName: 'scoped',
        bucketScope: 'specific',
        buckets: [{ region: S3Region.EuWest1, name: 'enabled-bucket' }],
      }),
    );
  });

  it('deletes a key after confirmation', async () => {
    mockList.mockResolvedValue({ keys: [KEY] });
    mockDelete.mockResolvedValue(undefined);

    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete API key ci key' }));

    expect(await screen.findByText('Delete "ci key"?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete key' }));

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('key-1'));
  });

  it('surfaces a create failure as a toast and keeps the modal open', async () => {
    mockCreate.mockRejectedValue(new Error('quota exceeded'));

    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Create API key/ }));
    fireEvent.change(screen.getByLabelText('Key name'), { target: { value: 'new key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));

    expect(await screen.findByText('quota exceeded')).toBeInTheDocument();
    expect(screen.queryByTestId('rag-key-token')).not.toBeInTheDocument();
  });
});
