import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { S3Region } from '@filone/shared';
import { ToastProvider } from '../components/Toast/index.js';
import { useFileUpload } from './use-file-upload.js';

vi.mock('./use-presign.js', () => ({
  batchPresign: vi.fn(),
}));

import { batchPresign } from './use-presign.js';
const mockBatchPresign = vi.mocked(batchPresign);

function wrapper({ children }: { children: React.ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}

function makeFile(name: string, size = 100): File {
  return new File(['x'.repeat(size)], name, { type: 'text/plain' });
}

const region = S3Region.UsEast1;
const bucketName = 'test-bucket';

function renderUpload(onSuccess?: () => void) {
  return renderHook(() => useFileUpload({ bucketName, region, onSuccess: onSuccess ?? vi.fn() }), {
    wrapper,
  });
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
