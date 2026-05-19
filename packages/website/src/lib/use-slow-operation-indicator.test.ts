import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useSlowOperationIndicator } from './use-slow-operation-indicator.js';

describe('useSlowOperationIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns { showSpinner: false, showMessage: false } initially when isLoading is true', () => {
    const { result } = renderHook(() => useSlowOperationIndicator(true));
    expect(result.current).toEqual({ showSpinner: false, showMessage: false });
  });

  it('returns { showSpinner: true, showMessage: false } after 400 ms elapsed', () => {
    const { result } = renderHook(() => useSlowOperationIndicator(true));
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current).toEqual({ showSpinner: true, showMessage: false });
  });

  it('returns { showSpinner: true, showMessage: true } after 1200 ms elapsed', () => {
    const { result } = renderHook(() => useSlowOperationIndicator(true));
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(result.current).toEqual({ showSpinner: true, showMessage: true });
  });

  it('resets both booleans to false when isLoading transitions to false after stage 2', () => {
    const { result, rerender } = renderHook(
      ({ isLoading }: { isLoading: boolean }) => useSlowOperationIndicator(isLoading),
      { initialProps: { isLoading: true } },
    );
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    rerender({ isLoading: false });
    expect(result.current).toEqual({ showSpinner: false, showMessage: false });
  });

  it('does not flip showSpinner to true when isLoading becomes false before 400 ms', () => {
    const { result, rerender } = renderHook(
      ({ isLoading }: { isLoading: boolean }) => useSlowOperationIndicator(isLoading),
      { initialProps: { isLoading: true } },
    );
    act(() => {
      vi.advanceTimersByTime(200);
    });
    rerender({ isLoading: false });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current.showSpinner).toBe(false);
  });

  it('does not log errors when unmounted before timers fire', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = renderHook(() => useSlowOperationIndicator(true));
    unmount();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
