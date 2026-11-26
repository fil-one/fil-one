import { describe, expect, it, vi } from 'vitest';
import type { PresignOp, PresignResponse } from '@filone/shared';

import { getPreviewUrl } from './preview-url.js';

const object = { region: 'eu-west-1', bucketName: 'any-bucket', objectKey: 'any-key.mp4' } as const;

function respondWith(url: string): PresignResponse {
  return { items: [{ url, method: 'GET', expiresAt: 'any-time' }], endpoint: 'any-endpoint' };
}

describe('getPreviewUrl', () => {
  // A custom expiry is what the presign handler refuses on a trial account
  it('asks for the standard expiry, so a trial account is never refused', async () => {
    const presign = vi.fn(async (_region: string, _ops: PresignOp[]) => respondWith('any-url'));

    await expect(getPreviewUrl(object, presign)).resolves.toMatchObject({ url: 'any-url' });
    expect(presign.mock.calls).toStrictEqual([
      ['eu-west-1', [{ op: 'getObject', bucket: 'any-bucket', key: 'any-key.mp4' }]],
    ]);
  });

  it('signs the version it is given', async () => {
    const presign = vi.fn(async (_region: string, _ops: PresignOp[]) => respondWith('any-url'));

    await getPreviewUrl({ ...object, versionId: 'any-version' }, presign);
    expect(presign.mock.calls).toStrictEqual([
      [
        'eu-west-1',
        [{ op: 'getObject', bucket: 'any-bucket', key: 'any-key.mp4', versionId: 'any-version' }],
      ],
    ]);
  });
});
