import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useBucketTabs } from './use-bucket-tabs.js';

describe('useBucketTabs', () => {
  it('keeps the chosen tab selected when a tab appears before it', () => {
    const { result, rerender } = renderHook((props) => useBucketTabs(props), {
      initialProps: { hasKeysTab: false, hasPolicyTab: true },
    });
    // Objects, Policy: index 1 is Policy.
    act(() => result.current.selectTabAt(1));

    // Objects, Keys, Policy: Policy moves to index 2.
    rerender({ hasKeysTab: true, hasPolicyTab: true });

    expect(result.current.selectedIndex).toBe(2);
  });

  it('falls back to Objects when the chosen tab goes away', () => {
    const { result, rerender } = renderHook((props) => useBucketTabs(props), {
      initialProps: { hasKeysTab: true, hasPolicyTab: true },
    });
    act(() => result.current.selectTabAt(2));

    rerender({ hasKeysTab: true, hasPolicyTab: false });

    expect(result.current.selectedIndex).toBe(0);
  });
});
