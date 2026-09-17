import { describe, expect, it } from 'vitest';

import { ACTIVITY_ACTION_LABELS, getActivityActionLabel } from './dashboard.ts';

describe('getActivityActionLabel', () => {
  it('returns the mapped label for a known action', () => {
    expect(getActivityActionLabel('object.uploaded')).toBe('Uploaded');
    expect(getActivityActionLabel('bucket.created')).toBe(ACTIVITY_ACTION_LABELS['bucket.created']);
  });

  it('humanizes the verb of an unmapped action instead of rendering undefined', () => {
    // A backend rolling out an action the console doesn't know yet.
    expect(getActivityActionLabel('object.restored')).toBe('Restored');
    expect(getActivityActionLabel('object.create.multipart')).toBe('Multipart');
  });

  it('falls back to a generic label when no verb can be derived', () => {
    expect(getActivityActionLabel('')).toBe('Activity');
    expect(getActivityActionLabel('object.')).toBe('Activity');
  });
});
