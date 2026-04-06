import { useEffect, useRef } from 'react';

export function useInfiniteScroll(
  fetchMore: () => void,
  hasMore: boolean,
  isLoading: boolean,
) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sentinelRef.current || !hasMore || isLoading) return;

    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        fetchMore();
      }
    });

    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [fetchMore, hasMore, isLoading]);

  return sentinelRef;
}
