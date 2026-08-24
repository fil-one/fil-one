import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import { BulkDeleteJobStatus, BulkDeleteScope, S3Region, type BulkDeleteJob } from '@filone/shared';

import { ToastProvider } from '../components/Toast/index.js';
import { useBulkDeleteJob } from './use-bulk-delete-job.js';

vi.mock('./api.js', () => ({ apiRequest: vi.fn() }));

import { apiRequest } from './api.js';
const mockApiRequest = vi.mocked(apiRequest);

function wrapper({ children }: { children: React.ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}

const bucketName = 'my-bucket';
const region = S3Region.EuWest1;

function job(overrides: Partial<BulkDeleteJob> = {}): BulkDeleteJob {
  return {
    jobId: 'job-1',
    bucketName,
    region,
    prefix: '',
    scope: BulkDeleteScope.AllVersions,
    status: BulkDeleteJobStatus.Running,
    deletedCount: 0,
    failedCount: 0,
    failures: [],
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function render(onFinished?: (j: BulkDeleteJob) => void) {
  return renderHook(() => useBulkDeleteJob({ bucketName, region, onFinished }), { wrapper });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('crypto', { randomUUID: () => '3f1a6b2c-8d4e-4f0a-9b3c-1d2e3f4a5b6c' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useBulkDeleteJob — start', () => {
  it('posts to the bucket bulk-delete endpoint with the region', async () => {
    mockApiRequest.mockResolvedValue({ job: job() });
    const { result } = render();

    await act(() => result.current.start());

    const [path, init] = mockApiRequest.mock.calls[0];
    expect(path).toBe('/buckets/my-bucket/bulk-delete?region=eu-west-1');
    expect(init?.method).toBe('POST');
  });

  it('defaults to the whole bucket and all versions', async () => {
    mockApiRequest.mockResolvedValue({ job: job() });
    const { result } = render();

    await act(() => result.current.start());

    const body = JSON.parse(mockApiRequest.mock.calls[0][1]!.body as string);
    expect(body.prefix).toBe('');
    expect(body.scope).toBe(BulkDeleteScope.AllVersions);
    expect(body.idempotencyKey).toBe('3f1a6b2c-8d4e-4f0a-9b3c-1d2e3f4a5b6c');
  });

  it('sends an explicit prefix when given one', async () => {
    mockApiRequest.mockResolvedValue({ job: job() });
    const { result } = render();

    await act(() => result.current.start({ prefix: 'photos/' }));

    expect(JSON.parse(mockApiRequest.mock.calls[0][1]!.body as string).prefix).toBe('photos/');
  });

  it('exposes the created job and marks it running', async () => {
    mockApiRequest.mockResolvedValue({ job: job() });
    const { result } = render();

    await act(() => result.current.start());

    expect(result.current.job?.jobId).toBe('job-1');
    expect(result.current.isRunning).toBe(true);
  });

  it('surfaces a start failure without leaving a job behind', async () => {
    mockApiRequest.mockRejectedValue(new Error('nope'));
    const { result } = render();

    await act(() => result.current.start());

    expect(result.current.job).toBeNull();
    expect(result.current.isRunning).toBe(false);
  });

  it('does not treat a finished job as running', async () => {
    mockApiRequest.mockResolvedValue({
      job: job({ status: BulkDeleteJobStatus.Completed, deletedCount: 5 }),
    });
    const { result } = render();

    await act(() => result.current.start());

    expect(result.current.isRunning).toBe(false);
  });
});

describe('useBulkDeleteJob — polling', () => {
  it('polls progress and reports completion once', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onFinished = vi.fn();
    mockApiRequest.mockResolvedValueOnce({ job: job() });
    const { result } = render(onFinished);

    await act(() => result.current.start());

    mockApiRequest.mockResolvedValue({
      job: job({ status: BulkDeleteJobStatus.Completed, deletedCount: 20_000 }),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    await waitFor(() => expect(result.current.job?.deletedCount).toBe(20_000));
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(result.current.isRunning).toBe(false);
  });

  it('keeps watching after a transient poll failure', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockApiRequest.mockResolvedValueOnce({ job: job() });
    const { result } = render();

    await act(() => result.current.start());

    mockApiRequest.mockRejectedValueOnce(new Error('network blip'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(result.current.isRunning).toBe(true);
  });

  it('stops polling once reset', async () => {
    mockApiRequest.mockResolvedValue({ job: job() });
    const { result } = render();
    await act(() => result.current.start());

    act(() => result.current.reset());

    expect(result.current.job).toBeNull();
    expect(result.current.isRunning).toBe(false);
  });
});
