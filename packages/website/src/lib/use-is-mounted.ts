import { useCallback, useEffect, useRef } from 'react';

/**
 * A function that tells whether the component calling this is still mounted,
 * for work that can finish after the user has left, such as a background upload.
 */
export function useIsMounted(): () => boolean {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return useCallback(() => mounted.current, []);
}
