import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, screen } from '@testing-library/react';

import { BulkDeleteJobStatus, BulkDeleteScope, S3Region, type BulkDeleteJob } from '@filone/shared';

import { ToastProvider } from '../components/Toast/index.js';
import { useFolderDeleteJobs } from './use-folder-delete-jobs.js';

vi.mock('./api.js', () => ({ apiRequest: vi.fn() }));

import { apiRequest } from './api.js';
const mockApiRequest = vi.mocked(apiRequest);

function wrapper({ children }: { children: React.ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}

/** A running job for `prefix`; each test overrides only what it is about. */
function job(prefix: string, overrides: Partial<BulkDeleteJob> = {}): BulkDeleteJob {
  return {
    jobId: `job-for-${prefix}`,
    bucketName: 'any-bucket',
    region: S3Region.EuWest1,
    prefix,
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

/** Answers each create with a running job for the prefix it was sent. */
function createRunningJobs() {
  mockApiRequest.mockImplementation((_path, init) => {
    const { prefix } = JSON.parse(init!.body as string) as { prefix: string };
    return Promise.resolve({ job: job(prefix) });
  });
}

/** Answers each progress read with `status` for the job it names. */
function reportJobs(statusFor: (jobId: string) => BulkDeleteJob) {
  mockApiRequest.mockImplementation((path) => {
    const jobId = decodeURIComponent(path.split('/').at(-1)!);
    return Promise.resolve({ job: statusFor(jobId) });
  });
}

function renderJobs(onFinished?: (jobs: BulkDeleteJob[]) => void) {
  return renderHook(
    () => useFolderDeleteJobs({ bucketName: 'any-bucket', region: S3Region.EuWest1, onFinished }),
    { wrapper },
  );
}

async function advancePoll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('crypto', { randomUUID: () => '3f1a6b2c-8d4e-4f0a-9b3c-1d2e3f4a5b6c' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useFolderDeleteJobs: starting', () => {
  it('starts one all-versions job per folder prefix', async () => {
    createRunningJobs();
    const { result } = renderJobs();

    await act(() => result.current.start(['any-folder/', 'other-folder/']));

    const bodies = mockApiRequest.mock.calls.map(([path, init]) => [
      path,
      JSON.parse(init!.body as string),
    ]);
    expect(bodies).toMatchObject([
      [
        '/buckets/any-bucket/bulk-delete?region=eu-west-1',
        { prefix: 'any-folder/', scope: BulkDeleteScope.AllVersions },
      ],
      [
        '/buckets/any-bucket/bulk-delete?region=eu-west-1',
        { prefix: 'other-folder/', scope: BulkDeleteScope.AllVersions },
      ],
    ]);
    expect(result.current.isRunning).toBe(true);
  });

  it('keeps the jobs that started, and says how many folders did not, when some fail', async () => {
    mockApiRequest
      .mockResolvedValueOnce({ job: job('any-folder/') })
      .mockRejectedValueOnce(new Error('any refusal'));
    const { result } = renderJobs();

    await act(() => result.current.start(['any-folder/', 'other-folder/']));

    expect(result.current.jobs.map((j) => j.prefix)).toStrictEqual(['any-folder/']);
    expect(await screen.findByText("Couldn't start deleting 1 of 2 folders")).toBeInTheDocument();
  });

  it("shows the API's reason when a single folder's deletion cannot start", async () => {
    mockApiRequest.mockRejectedValue(new Error('any refusal'));
    const { result } = renderJobs();

    await act(() => result.current.start(['any-folder/']));

    expect(result.current.jobs).toStrictEqual([]);
    expect(await screen.findByText('any refusal')).toBeInTheDocument();
  });
});

describe('useFolderDeleteJobs: watching', () => {
  it('keeps running while any job runs, and does not report finished', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onFinished = vi.fn();
    createRunningJobs();
    const { result } = renderJobs(onFinished);
    await act(() => result.current.start(['any-folder/', 'other-folder/']));

    reportJobs((jobId) =>
      jobId === 'job-for-any-folder/'
        ? job('any-folder/', { status: BulkDeleteJobStatus.Completed })
        : job('other-folder/'),
    );
    await advancePoll();

    expect(result.current.isRunning).toBe(true);
    expect(onFinished).not.toHaveBeenCalled();
  });

  it('reports finished once, with every job, when the last one finishes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onFinished = vi.fn();
    createRunningJobs();
    const { result } = renderJobs(onFinished);
    await act(() => result.current.start(['any-folder/', 'other-folder/']));

    reportJobs((jobId) =>
      job(jobId.replace('job-for-', ''), {
        status: BulkDeleteJobStatus.Completed,
        deletedCount: 2,
      }),
    );
    await advancePoll();
    await advancePoll();

    expect(result.current.isRunning).toBe(false);
    expect(onFinished.mock.calls).toMatchObject([
      [
        [
          { prefix: 'any-folder/', deletedCount: 2 },
          { prefix: 'other-folder/', deletedCount: 2 },
        ],
      ],
    ]);
  });

  it('keeps watching after a progress read fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    createRunningJobs();
    const { result } = renderJobs();
    await act(() => result.current.start(['any-folder/']));

    mockApiRequest.mockRejectedValue(new Error('any network failure'));
    await advancePoll();

    expect(result.current.isRunning).toBe(true);
  });
});
