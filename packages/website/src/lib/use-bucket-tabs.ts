import { useEffect, useRef, useState } from 'react';

type BucketTabId = 'objects' | 'keys' | 'policy';

/**
 * Which of the bucket page's tabs is open, held as an id rather than an index, as
 * `OrganizationPage` does: the Keys and Policy tabs depend on permissions that can change
 * mid-session, and an index would then point at a different tab than the one chosen.
 */
export function useBucketTabs({
  hasKeysTab,
  hasPolicyTab,
}: {
  hasKeysTab: boolean;
  hasPolicyTab: boolean;
}) {
  const [selectedTabId, setSelectedTabId] = useState<BucketTabId>('objects');
  const keysTabRef = useRef<HTMLButtonElement>(null);
  // Set when the page opens the Keys tab for the caller, so focus follows once it renders
  const isKeysTabFocusPending = useRef(false);

  const tabIds: BucketTabId[] = [
    'objects',
    ...(hasKeysTab ? (['keys'] as const) : []),
    ...(hasPolicyTab ? (['policy'] as const) : []),
  ];

  useEffect(() => {
    if (!isKeysTabFocusPending.current || selectedTabId !== 'keys') return;
    isKeysTabFocusPending.current = false;
    keysTabRef.current?.focus();
  }, [selectedTabId]);

  return {
    // Falls back to Objects when the chosen tab is gone, never to whichever tab now sits there
    selectedIndex: Math.max(0, tabIds.indexOf(selectedTabId)),
    selectTabAt: (index: number) => setSelectedTabId(tabIds[index] ?? 'objects'),
    keysTabRef,
    /**
     * Opens the Keys tab and moves focus onto it: the button that asked for it sits in the
     * panel being replaced, so focus would otherwise fall back to the page.
     */
    showKeysTab: () => {
      isKeysTabFocusPending.current = true;
      setSelectedTabId('keys');
    },
  };
}
