import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { S3_REGION, S3Region } from '@filone/shared';
import { ToastProvider } from '../components/Toast';
const mockSupportsIamMethods = vi.fn(() => false);
vi.mock('./access-model.js', () => ({ supportsIamMethods: () => mockSupportsIamMethods() }));

import { useAccessKeyForm } from './use-access-key-form.js';

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}

function renderForm(opts?: { defaultBucket?: string }) {
  return renderHook(() => useAccessKeyForm({ region: S3_REGION, onSuccess: () => {}, ...opts }), {
    wrapper,
  });
}

describe('useAccessKeyForm — canSubmit', () => {
  it('is false when key name is empty', () => {
    const { result } = renderForm();
    expect(result.current.canSubmit).toBe(false);
  });

  it('is true for a valid key name with default permissions', () => {
    const { result } = renderForm();
    act(() => result.current.setKeyName('my-key'));
    expect(result.current.canSubmit).toBe(true);
  });

  it('is false when key name contains invalid characters', () => {
    const { result } = renderForm();
    act(() => result.current.setKeyName('my@key'));
    expect(result.current.canSubmit).toBe(false);
  });

  it('is false for various disallowed characters', () => {
    const { result } = renderForm();
    const invalid = ['key!', 'key#name', 'key$', 'a/b', 'a\\b', 'key=val', 'hello+world'];
    for (const name of invalid) {
      act(() => result.current.setKeyName(name));
      expect(result.current.canSubmit).toBe(false);
    }
  });

  it('is true for names with allowed special characters', () => {
    const { result } = renderForm();
    const valid = ['my-key', 'my_key', 'my.key', 'My Key 1', 'a', 'A.B-C_D 0'];
    for (const name of valid) {
      act(() => result.current.setKeyName(name));
      expect(result.current.canSubmit).toBe(true);
    }
  });

  it('is false when key name exceeds 64 characters', () => {
    const { result } = renderForm();
    act(() => result.current.setKeyName('a'.repeat(65)));
    expect(result.current.canSubmit).toBe(false);
  });

  it('is true at exactly 64 characters', () => {
    const { result } = renderForm();
    act(() => result.current.setKeyName('a'.repeat(64)));
    expect(result.current.canSubmit).toBe(true);
  });

  it('is false when key name is only whitespace', () => {
    const { result } = renderForm();
    act(() => result.current.setKeyName('   '));
    expect(result.current.canSubmit).toBe(false);
  });

  it('is false when no permissions are selected', () => {
    const { result } = renderForm();
    act(() => {
      result.current.setKeyName('valid-key');
      result.current.setPermissions([]);
    });
    expect(result.current.canSubmit).toBe(false);
  });

  it('is false when bucket scope is specific but no buckets selected', () => {
    const { result } = renderForm();
    act(() => {
      result.current.setKeyName('valid-key');
      result.current.setBucketScope('specific');
      result.current.setSelectedBuckets([]);
    });
    expect(result.current.canSubmit).toBe(false);
  });

  it('is true when bucket scope is specific with a bucket selected', () => {
    const { result } = renderForm();
    act(() => {
      result.current.setKeyName('valid-key');
      result.current.setBucketScope('specific');
      result.current.setSelectedBuckets(['my-bucket']);
    });
    expect(result.current.canSubmit).toBe(true);
  });

  it('reset clears key name and restores canSubmit to false', () => {
    const { result } = renderForm();
    act(() => result.current.setKeyName('valid-key'));
    expect(result.current.canSubmit).toBe(true);
    act(() => result.current.reset());
    expect(result.current.canSubmit).toBe(false);
    expect(result.current.keyName).toBe('');
  });
});

describe('useAccessKeyForm — default permissions', () => {
  it('enables the bucket-info read permissions by default', () => {
    const { result } = renderForm();
    expect(result.current.permissions).toEqual(
      expect.arrayContaining(['GetBucketVersioning', 'GetBucketObjectLockConfiguration']),
    );
  });
});

describe('useAccessKeyForm — region change', () => {
  function renderWithRegion(initialRegion: S3Region, opts?: { defaultBucket?: string }) {
    return renderHook(
      ({ region }: { region: S3Region }) =>
        useAccessKeyForm({ region, onSuccess: () => {}, ...opts }),
      { initialProps: { region: initialRegion }, wrapper },
    );
  }

  it('clears selectedBuckets when the region changes', () => {
    const { result, rerender } = renderWithRegion(S3Region.EuWest1);
    act(() => result.current.setSelectedBuckets(['a', 'b']));
    expect(result.current.selectedBuckets).toEqual(['a', 'b']);

    rerender({ region: S3Region.UsEast1 });
    expect(result.current.selectedBuckets).toEqual([]);
  });

  it('leaves bucketScope unchanged when the region changes', () => {
    const { result, rerender } = renderWithRegion(S3Region.EuWest1);
    act(() => {
      result.current.setBucketScope('specific');
      result.current.setSelectedBuckets(['a']);
    });

    rerender({ region: S3Region.UsEast1 });
    expect(result.current.bucketScope).toBe('specific');
    expect(result.current.selectedBuckets).toEqual([]);
  });

  it('does not clear selectedBuckets on initial render when defaultBucket is provided', () => {
    const { result } = renderWithRegion(S3Region.EuWest1, { defaultBucket: 'b1' });
    expect(result.current.selectedBuckets).toEqual(['b1']);
  });

  it('does not clear selectedBuckets when re-rendered with the same region', () => {
    const { result, rerender } = renderWithRegion(S3Region.EuWest1);
    act(() => result.current.setSelectedBuckets(['a', 'b']));

    rerender({ region: S3Region.EuWest1 });
    expect(result.current.selectedBuckets).toEqual(['a', 'b']);
  });

  it('drops bucket-management permissions when switching to the Aurora region', () => {
    const { result, rerender } = renderWithRegion(S3Region.UsEast1);
    act(() => result.current.setPermissions(['read', 'CreateBucket', 'DeleteBucket']));
    expect(result.current.permissions).toEqual(['read', 'CreateBucket', 'DeleteBucket']);

    rerender({ region: S3Region.EuWest1 });
    expect(result.current.permissions).toEqual(['read']);
  });

  // The access-model mock answers for every region at once, so a switch
  // between a Forge region and another is staged by changing its answer
  // between renders.
  it('drops the bucket-configuration write when switching to a region that lacks it', () => {
    mockSupportsIamMethods.mockReturnValue(true);
    const { result, rerender } = renderWithRegion(S3Region.EuCentral3);
    act(() => result.current.setPermissions(['read', 'PutBucketCORS']));
    expect(result.current.permissions).toEqual(['read', 'PutBucketCORS']);

    mockSupportsIamMethods.mockReturnValue(false);
    rerender({ region: S3Region.UsEast1 });
    expect(result.current.permissions).toEqual(['read']);
  });

  it('keeps the bucket-configuration write when switching between Forge regions', () => {
    mockSupportsIamMethods.mockReturnValue(true);
    try {
      const { result, rerender } = renderWithRegion(S3Region.EuCentral3);
      act(() => result.current.setPermissions(['read', 'PutBucketCORS']));

      rerender({ region: S3Region.UsEast9 });
      expect(result.current.permissions).toEqual(['read', 'PutBucketCORS']);
    } finally {
      mockSupportsIamMethods.mockReturnValue(false);
    }
  });

  it('keeps bucket-management permissions when switching between non-Aurora regions', () => {
    const { result, rerender } = renderWithRegion(S3Region.EuWest1);
    rerender({ region: S3Region.UsEast1 });
    act(() => result.current.setPermissions(['read', 'CreateBucket']));

    rerender({ region: S3Region.UsEast1 });
    expect(result.current.permissions).toEqual(['read', 'CreateBucket']);
  });
});

describe('useAccessKeyForm — granular permission filtering', () => {
  it('strips data-protection granulars when their object permission is deselected', () => {
    const { result } = renderHook(
      () => useAccessKeyForm({ region: S3Region.UsEast1, onSuccess: () => {} }),
      { wrapper },
    );
    act(() => {
      result.current.setPermissions(['read', 'write', 'CreateBucket']);
      result.current.setGranularPermissions(['GetObjectVersion']);
    });

    // Deselecting `read` strips its data-protection granular.
    act(() => result.current.setPermissions(['write', 'CreateBucket']));
    expect(result.current.granularPermissions).toEqual([]);
  });

  it('keeps bucket-management permissions when an object permission is deselected', () => {
    const { result } = renderHook(
      () => useAccessKeyForm({ region: S3Region.UsEast1, onSuccess: () => {} }),
      { wrapper },
    );
    act(() => result.current.setPermissions(['read', 'CreateBucket']));

    act(() => result.current.setPermissions(['CreateBucket']));
    expect(result.current.permissions).toEqual(['CreateBucket']);
  });
});

describe('useAccessKeyForm — on a region serving the iam access model', () => {
  beforeEach(() => mockSupportsIamMethods.mockReturnValue(true));
  afterEach(() => mockSupportsIamMethods.mockReturnValue(false));

  function renderServiceKeyForm() {
    const rendered = renderForm();
    act(() => {
      rendered.result.current.setKeyName('nightly-backup');
      rendered.result.current.setKeyType('service');
    });
    return rendered;
  }

  it('builds a name-region-expiry request for a personal key', () => {
    const { result } = renderForm();
    act(() => result.current.setKeyName('laptop'));

    expect(result.current.request).toStrictEqual({
      keyName: 'laptop',
      region: S3_REGION,
      expiresAt: null,
    });
  });

  it('allows submit with no permissions for a personal key', () => {
    const { result } = renderForm();
    act(() => {
      result.current.setKeyName('laptop');
      result.current.setPermissions([]);
    });

    expect(result.current.canSubmit).toBe(true);
  });

  it('builds the service-key request once Service key is chosen', () => {
    const { result } = renderServiceKeyForm();

    expect(result.current.request).toStrictEqual({
      keyName: 'nightly-backup',
      permissions: [
        'read',
        'write',
        'list',
        'GetBucketVersioning',
        'GetBucketObjectLockConfiguration',
      ],
      granularPermissions: undefined,
      bucketScope: 'all',
      buckets: undefined,
      region: S3_REGION,
      expiresAt: null,
    });
  });

  it('blocks submit when a service key has no permissions', () => {
    const { result } = renderServiceKeyForm();
    act(() => result.current.setPermissions([]));

    expect(result.current.canSubmit).toBe(false);
  });

  it('allows submit again after switching back to a personal key', () => {
    const { result } = renderServiceKeyForm();
    act(() => result.current.setPermissions([]));
    act(() => result.current.setKeyType('principal'));

    expect(result.current.canSubmit).toBe(true);
  });
});
