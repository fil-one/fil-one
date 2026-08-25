import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { S3Region } from '@filone/shared';
import { ToastProvider } from '../components/Toast/index.js';
import { queryKeys } from './query-client.js';
import {
  calculateUploadProgress,
  isSystemFileInput,
  useFileUpload,
  type FileEntry,
} from './use-file-upload.js';

vi.mock('./use-presign.js', () => ({
  batchPresign: vi.fn(),
}));

import { batchPresign } from './use-presign.js';
const mockBatchPresign = vi.mocked(batchPresign);

function makeFile(name: string, size = 100): File {
  return new File(['x'.repeat(size)], name, { type: 'text/plain' });
}

const region = S3Region.UsEast1;
const bucketName = 'test-bucket';

function renderUpload(onSuccess?: () => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    );
  }
  const view = renderHook(
    () => useFileUpload({ bucketName, region, onSuccess: onSuccess ?? vi.fn() }),
    { wrapper },
  );
  return { ...view, client };
}

describe('useFileUpload — addFiles', () => {
  it('adds plain File objects to the list', () => {
    const { result } = renderUpload();
    act(() => result.current.addFiles([makeFile('a.txt'), makeFile('b.txt')], ''));
    expect(result.current.files).toHaveLength(2);
    expect(result.current.files[0].file.name).toBe('a.txt');
    expect(result.current.files[1].file.name).toBe('b.txt');
  });

  it('derives key from file name with no prefix', () => {
    const { result } = renderUpload();
    act(() => result.current.addFiles([makeFile('img.png')], ''));
    expect(result.current.files[0].key).toBe('img.png');
  });

  it('derives key with prefix', () => {
    const { result } = renderUpload();
    act(() => result.current.addFiles([makeFile('img.png')], 'photos/'));
    expect(result.current.files[0].key).toBe('photos/img.png');
  });

  it('strips trailing slashes from prefix', () => {
    const { result } = renderUpload();
    act(() => result.current.addFiles([makeFile('img.png')], 'photos///'));
    expect(result.current.files[0].key).toBe('photos/img.png');
  });

  it('uses relativePath as key for folder entries', () => {
    const { result } = renderUpload();
    act(() =>
      result.current.addFiles(
        [{ file: makeFile('img.png'), relativePath: 'vacation/2024/img.png' }],
        'ignored-prefix',
      ),
    );
    expect(result.current.files[0].key).toBe('vacation/2024/img.png');
    expect(result.current.files[0].relativePath).toBe('vacation/2024/img.png');
  });

  it('assigns unique ids to every entry', () => {
    const { result } = renderUpload();
    act(() =>
      result.current.addFiles([makeFile('a.txt'), makeFile('b.txt'), makeFile('c.txt')], ''),
    );
    const ids = result.current.files.map((e) => e.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('filters OS metadata, hidden files, and __MACOSX content out of a folder', async () => {
    const { result } = renderUpload();
    act(() =>
      result.current.addFiles(
        [
          { file: makeFile('.DS_Store'), relativePath: 'photos/.DS_Store' },
          { file: makeFile('Thumbs.db'), relativePath: 'photos/Thumbs.db' },
          { file: makeFile('._photo.jpg'), relativePath: '__MACOSX/photos/._photo.jpg' },
          { file: makeFile('.secret'), relativePath: 'photos/.secret' },
          { file: makeFile('photo.jpg'), relativePath: 'photos/photo.jpg' },
        ],
        '',
      ),
    );
    expect(result.current.files.map(({ key }) => key)).toEqual(['photos/photo.jpg']);
    expect(await screen.findByText('Skipped 4 system files')).toBeTruthy();
  });

  it('keeps a dotfile the user selected on its own', () => {
    const { result } = renderUpload();
    act(() => result.current.addFiles([makeFile('.env'), makeFile('a.txt')], ''));
    expect(result.current.files.map(({ key }) => key)).toEqual(['.env', 'a.txt']);
    expect(screen.queryByTestId('toast')).toBeNull();
  });
});

describe('upload progress helpers', () => {
  const entry = (
    name: string,
    size: number,
    status: FileEntry['status'],
    progress: number,
  ): FileEntry => ({
    id: name,
    file: makeFile(name, size),
    key: name,
    status,
    progress,
  });

  it('weights progress by bytes rather than file count', () => {
    const progress = calculateUploadProgress([
      entry('small', 10, 'done', 100),
      entry('large', 90, 'uploading', 50),
    ]);
    expect(progress).toEqual({ totalBytes: 100, uploadedBytes: 55, percent: 55 });
  });

  it('does not retain failed-attempt bytes while a retry is pending', () => {
    const progress = calculateUploadProgress([
      entry('done', 20, 'done', 100),
      entry('retry', 80, 'error', 75),
    ]);
    expect(progress).toEqual({ totalBytes: 100, uploadedBytes: 20, percent: 20 });
  });

  it('never reports 100 percent while a file is still queued', () => {
    expect(
      calculateUploadProgress([entry('big', 999, 'done', 100), entry('tiny', 1, 'pending', 0)])
        .percent,
    ).toBe(99);
    expect(
      calculateUploadProgress([entry('big', 1000, 'done', 100), entry('empty', 0, 'pending', 0)])
        .percent,
    ).toBe(99);
  });

  it('counts empty files evenly when there are no bytes to weigh', () => {
    expect(
      calculateUploadProgress([entry('a', 0, 'done', 100), entry('b', 0, 'pending', 0)]),
    ).toEqual({ totalBytes: 0, uploadedBytes: 0, percent: 50 });
  });

  it('ignores a non-finite per-file progress value', () => {
    expect(calculateUploadProgress([entry('empty', 0, 'uploading', Number.NaN)])).toEqual({
      totalBytes: 0,
      uploadedBytes: 0,
      percent: 0,
    });
  });

  it('identifies system path segments without filtering normal nested files', () => {
    expect(isSystemFileInput({ file: makeFile('x'), relativePath: 'folder/__MACOSX/x' })).toBe(
      true,
    );
    expect(isSystemFileInput({ file: makeFile('x'), relativePath: 'folder/x' })).toBe(false);
    expect(isSystemFileInput(makeFile('.DS_Store'))).toBe(false);
  });
});

describe('useFileUpload — prefix re-derivation', () => {
  it('updates keys for individual files when prefix changes', async () => {
    const { result } = renderUpload();
    act(() => result.current.addFiles([makeFile('img.png')], ''));
    expect(result.current.files[0].key).toBe('img.png');

    act(() => result.current.setPrefix('uploads/'));
    await waitFor(() => expect(result.current.files[0].key).toBe('uploads/img.png'));
  });

  it('does not change keys for folder entries when prefix changes', async () => {
    const { result } = renderUpload();
    act(() =>
      result.current.addFiles(
        [{ file: makeFile('img.png'), relativePath: 'vacation/img.png' }],
        '',
      ),
    );

    act(() => result.current.setPrefix('uploads/'));
    await waitFor(() => expect(result.current.files[0].key).toBe('vacation/img.png'));
  });
});

describe('useFileUpload — removeFile / removeFolderFiles', () => {
  it('removes a single file by id', () => {
    const { result } = renderUpload();
    act(() => result.current.addFiles([makeFile('a.txt'), makeFile('b.txt')], ''));
    const id = result.current.files[0].id;
    act(() => result.current.removeFile(id));
    expect(result.current.files).toHaveLength(1);
    expect(result.current.files[0].file.name).toBe('b.txt');
  });

  it('removes all files belonging to a folder root', () => {
    const { result } = renderUpload();
    act(() =>
      result.current.addFiles(
        [
          { file: makeFile('a.png'), relativePath: 'vacation/a.png' },
          { file: makeFile('b.png'), relativePath: 'vacation/b.png' },
          makeFile('standalone.txt'),
        ],
        '',
      ),
    );
    act(() => result.current.removeFolderFiles('vacation'));
    expect(result.current.files).toHaveLength(1);
    expect(result.current.files[0].file.name).toBe('standalone.txt');
  });
});

describe('useFileUpload — upload flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBatchPresign.mockResolvedValue({
      endpoint: 'https://s3.example.com',
      items: [
        { url: 'https://s3.example.com/upload', method: 'PUT', expiresAt: '2099-01-01T00:00:00Z' },
      ],
    });

    function FakeXHR(this: {
      upload: { onprogress: unknown };
      onload: (() => void) | null;
      onerror: unknown;
      open: ReturnType<typeof vi.fn>;
      setRequestHeader: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
      status: number;
    }) {
      this.upload = { onprogress: null };
      this.onload = null;
      this.onerror = null;
      this.status = 200;
      this.open = vi.fn();
      this.setRequestHeader = vi.fn();
      this.send = vi.fn().mockImplementation(() => {
        this.onload?.();
      });
    }
    global.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
  });

  it('sets uploadStep to done after successful upload', async () => {
    const onSuccess = vi.fn();
    const { result } = renderUpload(onSuccess);
    act(() => result.current.addFiles([makeFile('file.txt')], ''));
    await act(() => result.current.handleUpload());
    await waitFor(() => expect(result.current.uploadStep).toBe('done'));
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it('invalidates the bucket object and analytics queries after a successful upload', async () => {
    const { result, client } = renderUpload();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => result.current.addFiles([makeFile('file.txt')], ''));
    await act(() => result.current.handleUpload());
    await waitFor(() => expect(result.current.uploadStep).toBe('done'));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.objects(bucketName, region) });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.bucketAnalytics(bucketName, region),
    });
  });

  it('does not invalidate when the upload fails', async () => {
    mockBatchPresign.mockRejectedValue(new Error('Presign failed'));
    const { result, client } = renderUpload();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => result.current.addFiles([makeFile('file.txt')], ''));
    await act(() => result.current.handleUpload());
    await waitFor(() => expect(result.current.uploadStep).toBe('idle'));
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('sets uploadStep to idle and marks files as error on presign failure', async () => {
    mockBatchPresign.mockRejectedValue(new Error('Presign failed'));
    const { result } = renderUpload();
    act(() => result.current.addFiles([makeFile('file.txt')], ''));
    await act(() => result.current.handleUpload());
    await waitFor(() => expect(result.current.uploadStep).toBe('idle'));
    expect(result.current.files[0].status).toBe('error');
  });
});

describe('useFileUpload — retry', () => {
  it('retries only failed files', async () => {
    mockBatchPresign.mockRejectedValueOnce(new Error('Presign failed')).mockResolvedValueOnce({
      endpoint: 'https://s3.example.com',
      items: [
        { url: 'https://s3.example.com/upload', method: 'PUT', expiresAt: '2099-01-01T00:00:00Z' },
      ],
    });

    const { result } = renderUpload();
    act(() => result.current.addFiles([makeFile('file.txt')], ''));
    await act(() => result.current.handleUpload());
    await waitFor(() => expect(result.current.files[0].status).toBe('error'));

    await act(() => result.current.handleRetry());
    await waitFor(() => expect(result.current.uploadStep).toBe('done'));
    expect(result.current.files[0].status).toBe('done');
  });

  it('retains completed bytes and resets a failed unequal-size upload before retry', async () => {
    type ControlledXHR = {
      upload: { onprogress: ((event: ProgressEvent) => void) | null };
      onload: (() => void) | null;
      onerror: (() => void) | null;
      open: ReturnType<typeof vi.fn>;
      setRequestHeader: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
      status: number;
    };
    const requests: ControlledXHR[] = [];
    global.XMLHttpRequest = function ControlledFakeXHR(this: ControlledXHR) {
      this.upload = { onprogress: null };
      this.onload = null;
      this.onerror = null;
      this.status = 200;
      this.open = vi.fn();
      this.setRequestHeader = vi.fn();
      this.send = vi.fn();
      requests.push(this);
    } as unknown as typeof XMLHttpRequest;
    mockBatchPresign.mockResolvedValue({
      endpoint: 'https://s3.example.com',
      items: [
        { url: 'https://s3.example.com/small', method: 'PUT', expiresAt: '2099-01-01T00:00:00Z' },
        { url: 'https://s3.example.com/large', method: 'PUT', expiresAt: '2099-01-01T00:00:00Z' },
      ],
    });

    const { result } = renderUpload();
    act(() => result.current.addFiles([makeFile('small.txt', 10), makeFile('large.txt', 90)], ''));

    let upload: Promise<void>;
    act(() => {
      upload = result.current.handleUpload();
    });
    await waitFor(() => expect(requests).toHaveLength(2));

    act(() => {
      requests[0].upload.onprogress?.({
        lengthComputable: true,
        loaded: 0,
        total: 0,
      } as ProgressEvent);
    });
    expect(result.current.files[0].progress).toBe(0);

    act(() => {
      requests[0].upload.onprogress?.({
        lengthComputable: true,
        loaded: 10,
        total: 10,
      } as ProgressEvent);
      requests[1].upload.onprogress?.({
        lengthComputable: true,
        loaded: 45,
        total: 90,
      } as ProgressEvent);
    });
    await waitFor(() => expect(result.current.progressPercent).toBe(55));

    act(() => {
      requests[0].onload?.();
      requests[1].status = 500;
      requests[1].onload?.();
    });
    await upload!;
    await waitFor(() => {
      expect(result.current.files.map(({ status }) => status)).toEqual(['done', 'error']);
      expect(result.current.progressPercent).toBe(10);
    });

    let retry: Promise<void>;
    act(() => {
      retry = result.current.handleRetry();
    });
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(result.current.files[1].progress).toBe(0);

    act(() => {
      requests[2].upload.onprogress?.({
        lengthComputable: true,
        loaded: 45,
        total: 90,
      } as ProgressEvent);
    });
    await waitFor(() => expect(result.current.progressPercent).toBe(55));
    act(() => requests[2].onload?.());
    await retry!;
    await waitFor(() => expect(result.current.progressPercent).toBe(100));
  });
});

describe('useFileUpload — reset', () => {
  it('clears files and prefix and returns to idle', () => {
    const { result } = renderUpload();
    act(() => {
      result.current.addFiles([makeFile('a.txt')], '');
      result.current.setPrefix('uploads/');
    });
    act(() => result.current.reset());
    expect(result.current.files).toHaveLength(0);
    expect(result.current.prefix).toBe('');
    expect(result.current.uploadStep).toBe('idle');
  });
});
