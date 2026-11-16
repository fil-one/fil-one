import { describe, expect, it, vi } from 'vitest';
import { ApiErrorCode } from '@filone/shared';
import type { PresignOp, PresignResponse } from '@filone/shared';

import { getPreviewUrl, PREVIEW_URL_EXPIRY_SECONDS } from './preview-url.js';

const object = { region: 'eu-west-1', bucketName: 'any-bucket', objectKey: 'any-key.mp4' } as const;

function respondWith(url: string): PresignResponse {
  return { items: [{ url, method: 'GET', expiresAt: 'any-time' }], endpoint: 'any-endpoint' };
}

// What `apiRequest` throws when the presign handler refuses a trial account.
const trialBlocked = Object.assign(new Error('blocked'), {
  status: 402,
  code: ApiErrorCode.TRIAL_PRESIGN_BLOCKED,
});

describe('getPreviewUrl', () => {
  it('returns an hour-long URL when the account may choose an expiry', async () => {
    const presign = vi.fn(async (_region: string, _ops: PresignOp[]) => respondWith('long-url'));

    await expect(getPreviewUrl(object, presign)).resolves.toMatchObject({ url: 'long-url' });
    expect(presign.mock.calls).toStrictEqual([
      [
        'eu-west-1',
        [
          {
            op: 'getObject',
            bucket: 'any-bucket',
            key: 'any-key.mp4',
            expiresIn: PREVIEW_URL_EXPIRY_SECONDS,
          },
        ],
      ],
    ]);
  });

  it('falls back to the standard expiry when a trial account is refused a custom one', async () => {
    const presign = vi
      .fn<(region: string, ops: PresignOp[]) => Promise<PresignResponse>>()
      .mockRejectedValueOnce(trialBlocked)
      .mockResolvedValueOnce(respondWith('standard-url'));

    await expect(
      getPreviewUrl({ ...object, versionId: 'any-version' }, presign),
    ).resolves.toMatchObject({ url: 'standard-url' });
    expect(presign).toHaveBeenLastCalledWith('eu-west-1', [
      { op: 'getObject', bucket: 'any-bucket', key: 'any-key.mp4', versionId: 'any-version' },
    ]);
  });

  it('rethrows any other presign failure without retrying', async () => {
    const failure = Object.assign(new Error('forbidden'), { status: 403 });
    const presign = vi
      .fn<(region: string, ops: PresignOp[]) => Promise<PresignResponse>>()
      .mockRejectedValue(failure);

    await expect(getPreviewUrl(object, presign)).rejects.toBe(failure);
    expect(presign).toHaveBeenCalledTimes(1);
  });
});
