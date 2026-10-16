import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { S3Region } from '@filone/shared';

import { ShareObjectModal } from './ShareObjectModal';

type PresignResult = { url: string; expiresAt: string };

const mockGeneratePresignedUrl = vi.fn<(key: string) => Promise<PresignResult | undefined>>();

vi.mock('../lib/use-object-actions', () => ({
  useObjectActions: () => ({
    generatePresignedUrl: mockGeneratePresignedUrl,
    generatingUrl: false,
  }),
}));

function renderModal(props: { open: boolean; objectKey: string }) {
  return (
    <ShareObjectModal
      {...props}
      onClose={() => {}}
      bucketName="any-bucket"
      region={S3Region.UsEast1}
    />
  );
}

describe('ShareObjectModal', () => {
  it('discards a link that arrives after the dialog closed and reopened for another object', async () => {
    let resolveFirstLink: (result: PresignResult) => void = () => {};
    mockGeneratePresignedUrl.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirstLink = resolve;
      }),
    );
    const { rerender } = render(renderModal({ open: true, objectKey: 'any-object-a' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate link' }));

    rerender(renderModal({ open: false, objectKey: 'any-object-a' }));
    rerender(renderModal({ open: true, objectKey: 'any-object-b' }));
    await act(async () => {
      resolveFirstLink({
        url: 'https://example.test/any-object-a',
        expiresAt: '2026-01-01T00:00:00Z',
      });
    });

    expect(screen.queryByText('https://example.test/any-object-a')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate link' })).toBeInTheDocument();
  });
});
