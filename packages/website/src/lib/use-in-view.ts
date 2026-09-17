import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/**
 * Call something when an element scrolls into view.
 *
 * For a list that continues as the reader reaches its end. Attach the returned
 * ref to a sentinel after the last row rather than to the row itself, so the
 * next page is asked for while the reader is still looking at this one.
 *
 * The callback fires on entry, not continuously: `IntersectionObserver` reports
 * threshold crossings, so a sentinel that stays in view does not fire again. To
 * ask for a page after that, flip `enabled` off while the request is in flight
 * and on again afterwards — the observer is rebuilt and reports the sentinel it
 * finds still on screen.
 *
 * `enabled` is also the off switch for the two states where firing would be
 * wrong: nothing left to load, and a load that just failed. Retrying on scroll
 * would put a failing request behind every wheel event.
 */
export function useInView<T extends HTMLElement>(
  onEnter: () => void,
  { enabled = true, rootMargin = '200px' }: { enabled?: boolean; rootMargin?: string } = {},
): RefObject<T | null> {
  const target = useRef<T | null>(null);
  // Held in a ref so a new inline callback each render does not rebuild the
  // observer, which would report the sentinel again and fire on every render.
  const handler = useRef(onEnter);

  useEffect(() => {
    handler.current = onEnter;
  }, [onEnter]);

  useEffect(() => {
    const sentinel = target.current;
    // Absent in jsdom, and in a browser old enough not to matter here. Nothing
    // observes, so a list that depends on this needs a control of its own.
    if (!enabled || !sentinel || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) handler.current();
      },
      { rootMargin },
    );
    observer.observe(sentinel);

    return () => observer.disconnect();
  }, [enabled, rootMargin]);

  return target;
}
