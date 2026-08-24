import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { S3Region } from '@filone/shared';

import { ToastProvider } from '../components/Toast/index.js';
import { useObjectActions } from './use-object-actions.js';

vi.mock('./use-presign.js', () => ({ batchPresign: vi.fn() }));
vi.mock('./aurora-s3.js', () => ({ executePresignedUrl: vi.fn() }));

import { batchPresign } from './use-presign.js';
import { executePresignedUrl } from './aurora-s3.js';

const mockBatchPresign = vi.mocked(batchPresign);
const mockExecute = vi.mocked(executePresignedUrl);

const region = S3Region.UsEast1;
const bucketName = 'test-bucket';

function wrapper({ children }: { children: React.ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}

function renderActions(onDeleted = vi.fn()) {
  const rendered = renderHook(() => useObjectActions({ bucketName, region, onDeleted }), {
    wrapper,
  });
  return { ...rendered, onDeleted };
}

/** Presign returns one item per requested op. */
function presignItemsFor(ops: unknown[]) {
  return Promise.resolve({
    endpoint: 'https://s3.example',
    items: (ops as { key: string }[]).map((op) => ({
      url: `https://s3.example/${op.key}`,
      method: 'DELETE' as const,
      expiresAt: '2026-01-01T00:00:00.000Z',
    })),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockBatchPresign.mockImplementation((_region, ops) => presignItemsFor(ops));
  mockExecute.mockResolvedValue(new Response(null, { status: 204 }));
});

describe('useObjectActions — deleteObjects', () => {
  it('does nothing when given no targets', async () => {
    const { result } = renderActions();
    await act(() => result.current.deleteObjects([]));
    expect(mockBatchPresign).not.toHaveBeenCalled();
  });

  it('deletes every target and reports each one', async () => {
    const { result, onDeleted } = renderActions();

    await act(() =>
      result.current.deleteObjects([{ key: 'a.txt' }, { key: 'b.txt', versionId: 'v2' }]),
    );

    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(onDeleted).toHaveBeenCalledWith('a.txt', undefined);
    expect(onDeleted).toHaveBeenCalledWith('b.txt', 'v2');
  });

  it('forwards versionId only when present', async () => {
    const { result } = renderActions();

    await act(() =>
      result.current.deleteObjects([{ key: 'a.txt' }, { key: 'b.txt', versionId: 'v2' }]),
    );

    expect(mockBatchPresign).toHaveBeenCalledWith(region, [
      { op: 'deleteObject', bucket: bucketName, key: 'a.txt' },
      { op: 'deleteObject', bucket: bucketName, key: 'b.txt', versionId: 'v2' },
    ]);
  });

  it('chunks targets to stay within the 10-op presign limit', async () => {
    const { result } = renderActions();
    const targets = Array.from({ length: 23 }, (_, i) => ({ key: `obj-${i}.txt` }));

    await act(() => result.current.deleteObjects(targets));

    expect(mockBatchPresign).toHaveBeenCalledTimes(3);
    expect(mockBatchPresign.mock.calls[0][1]).toHaveLength(10);
    expect(mockBatchPresign.mock.calls[2][1]).toHaveLength(3);
    expect(mockExecute).toHaveBeenCalledTimes(23);
  });

  it('keeps going when one delete fails and reports only the successes', async () => {
    const { result, onDeleted } = renderActions();
    mockExecute
      .mockRejectedValueOnce(new Error('denied'))
      .mockResolvedValue(new Response(null, { status: 204 }));

    await act(() => result.current.deleteObjects([{ key: 'a.txt' }, { key: 'b.txt' }]));

    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(onDeleted).toHaveBeenCalledWith('b.txt', undefined);
  });

  it('continues to the next chunk when a whole presign request fails', async () => {
    const { result, onDeleted } = renderActions();
    mockBatchPresign
      .mockRejectedValueOnce(new Error('presign down'))
      .mockImplementation((_region, ops) => presignItemsFor(ops));

    const targets = Array.from({ length: 12 }, (_, i) => ({ key: `obj-${i}.txt` }));
    await act(() => result.current.deleteObjects(targets));

    expect(mockBatchPresign).toHaveBeenCalledTimes(2);
    expect(onDeleted).toHaveBeenCalledTimes(2);
  });

  it('resets the bulk-deleting flag when finished', async () => {
    const { result } = renderActions();
    await act(() => result.current.deleteObjects([{ key: 'a.txt' }]));
    expect(result.current.bulkDeleting).toBe(false);
  });
});
