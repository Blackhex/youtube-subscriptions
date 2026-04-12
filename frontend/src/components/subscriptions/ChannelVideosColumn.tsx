import { useState, useCallback, useEffect, useRef } from 'react';
import { Close, OpenInNew } from '@mui/icons-material';
import type { Video } from '../../types';
import VideoItem from '../feeds/VideoItem';
import AddToPlaylistModal from '../feeds/AddToPlaylistModal';
import { useQueue } from '../../hooks/useQueue';
import { useInfiniteScroll } from '../../hooks/useInfiniteScroll';
import * as api from '../../api/client';

interface ChannelVideosColumnProps {
  channelId: string;
  channelTitle: string;
  onClose: () => void;
}

export default function ChannelVideosColumn({ channelId, channelTitle, onClose }: ChannelVideosColumnProps) {
  const [videos, setVideos] = useState<Video[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const { addToQueue } = useQueue();
  const [addToPlaylistVideo, setAddToPlaylistVideo] = useState<Video | null>(null);
  const progressRef = useRef<Record<string, number>>({});

  const markWatched = useCallback(async (videoId: string) => {
    try {
      await api.markVideoWatched(videoId);
      setVideos(prev => prev.map(v =>
        v.video_id === videoId ? { ...v, playback_progress: 100 } : v
      ));
    } catch {
      // silent fail
    }
  }, []);

  const fetchVideos = useCallback(async (pageNum: number) => {
    setLoading(true);
    try {
      const res = await api.fetchSubscriptionVideos(channelId, { page: pageNum, per_page: 20 });
      const applyProgress = (items: Video[]) =>
        items.map(v => {
          const pct = progressRef.current[v.video_id];
          return pct !== undefined ? { ...v, playback_progress: pct } : v;
        });
      if (pageNum === 1) {
        setVideos(applyProgress(res.data.items));
      } else {
        setVideos(prev => [...prev, ...applyProgress(res.data.items)]);
      }
      setHasMore(res.data.has_more);
      setTotal(res.data.total);
      setPage(pageNum);
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    fetchVideos(1);
  }, [fetchVideos]);

  useEffect(() => {
    let cancelled = false;
    api.fetchChannelProgress(channelId).then(res => {
      if (cancelled) return;
      progressRef.current = res.data.progress;
      setVideos(prev => prev.map(v => {
        const pct = res.data.progress[v.video_id];
        return pct !== undefined ? { ...v, playback_progress: pct } : v;
      }));
    }).catch(() => { /* silent fail */ });
    return () => { cancelled = true; };
  }, [channelId]);

  const loadMore = useCallback(() => {
    if (!loading && hasMore) {
      fetchVideos(page + 1);
    }
  }, [loading, hasMore, page, fetchVideos]);

  const sentinelRef = useInfiniteScroll(loadMore, hasMore, loading);

  return (
    <div className="column channel-videos-column">
      <div className="column-header">
        <h3>{channelTitle} <span className="text-muted fs-6 fw-normal">({total})</span></h3>
        <div className="d-flex align-items-center gap-1">
          <a
            className="btn-action"
            title="Open channel on YouTube"
            href={`https://www.youtube.com/channel/${channelId}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <OpenInNew style={{ fontSize: '1rem' }} />
          </a>
          <button className="btn-action" title="Close" onClick={onClose}>
            <Close style={{ fontSize: '1rem' }} />
          </button>
        </div>
      </div>
      <div className="column-body">
        {videos.map((video) => (
          <VideoItem
            key={video.id}
            video={video}
            actions={{
              onAddToQueue: (videoId) => addToQueue(videoId),
              onAddToPlaylist: () => setAddToPlaylistVideo(video),
              onMarkWatched: (videoId) => markWatched(videoId),
            }}
          />
        ))}
        {loading && (
          <div className="text-center py-2">
            <div className="spinner-border spinner-border-sm text-secondary" role="status" />
          </div>
        )}
        <div ref={sentinelRef} style={{ height: 1 }} />
        {!loading && videos.length === 0 && (
          <div className="empty-state">
            <p>No videos found for this channel</p>
          </div>
        )}
      </div>
      {addToPlaylistVideo && (
        <AddToPlaylistModal
          video={addToPlaylistVideo}
          onClose={() => setAddToPlaylistVideo(null)}
        />
      )}
    </div>
  );
}
