import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { ToastProvider } from '../components/Toast';
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
  return renderHook(() => useAccessKeyForm({ onSuccess: () => {}, ...opts }), { wrapper });
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
