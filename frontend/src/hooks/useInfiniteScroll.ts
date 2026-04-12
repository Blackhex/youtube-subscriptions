import { useEffect, useRef } from 'react';

function findScrollParent(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement;
  while (current) {
    const overflowY = getComputedStyle(current).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return current;
    current = current.parentElement;
  }
  return null;
}

export function useInfiniteScroll(
  fetchMore: () => void,
  hasMore: boolean,
  isLoading: boolean,
) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sentinelRef.current || !hasMore || isLoading) return;
    if (typeof IntersectionObserver === 'undefined') return;

    // The sentinel is zero-height and sits flush with (sometimes a subpixel past) the
    // scroll container's clipped edge, so the container must be the root for rootMargin
    // to apply — rootMargin never expands intermediate ancestor clip rects.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          fetchMore();
        }
      },
      {
        root: findScrollParent(sentinelRef.current),
        rootMargin: '0px 0px 300px 0px',
      },
    );

    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [fetchMore, hasMore, isLoading]);

  return sentinelRef;
}
