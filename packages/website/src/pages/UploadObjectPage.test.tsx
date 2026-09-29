import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { S3Region } from '@filone/shared';
import { ToastProvider } from '../components/Toast/index.js';
import { queryKeys } from '../lib/query-client.js';
import type { UseFileUploadOptions } from '../lib/use-file-upload.js';
import { UploadObjectPage } from './UploadObjectPage';

const { navigate, uploadOptions } = vi.hoisted(() => ({
  navigate: vi.fn(),
  uploadOptions: { current: null as UseFileUploadOptions | null },
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

// The page is what decides where finishing an upload goes, so the hook is
// reduced to handing over the `onSuccess` it was given.
vi.mock('../lib/use-file-upload.js', () => ({
  useFileUpload: (options: UseFileUploadOptions) => {
    uploadOptions.current = options;
    return {
      uploadStep: 'uploading',
      files: [],
      prefix: '',
      setPrefix: vi.fn(),
      fileInputRef: { current: null },
      folderInputRef: { current: null },
      addFiles: vi.fn(),
      handleFilesSelect: vi.fn(),
      handleFolderSelect: vi.fn(),
      removeFile: vi.fn(),
      removeFolderFiles: vi.fn(),
      handleUpload: vi.fn(),
      handleRetry: vi.fn(),
      reset: vi.fn(),
      doneCount: 0,
      failedCount: 0,
      pendingCount: 0,
      canUpload: false,
      hasIndividualFiles: false,
      totalBytes: 0,
      uploadedBytes: 0,
      progressPercent: 0,
    };
  },
}));

const bucketName = 'photos';
const region = S3Region.UsEast1;

function renderPage() {
  const client = new QueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <UploadObjectPage bucketName={bucketName} region={region} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

describe('UploadObjectPage: finishing an upload', () => {
  beforeEach(() => {
    navigate.mockReset();
    uploadOptions.current = null;
  });

  it('takes the user to the bucket when they are still on the page', () => {
    renderPage();
    uploadOptions.current?.onSuccess?.();

    expect(navigate).toHaveBeenCalledWith({
      to: '/buckets/$bucketName',
      params: { bucketName },
      search: { region },
    });
  });

  it('leaves a user who moved on where they are, and still refreshes usage', () => {
    const { unmount, client } = renderPage();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    unmount();

    // The upload carried on in the background after the user left.
    uploadOptions.current?.onSuccess?.();

    expect(navigate).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.usage });
  });
});
