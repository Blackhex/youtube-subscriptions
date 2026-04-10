import React from 'react';
import type { SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities';
import type { Video } from '../../types';
import { PlaylistAdd, PlaylistAddCheck, Close, DragIndicator, Visibility } from '@mui/icons-material';

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function timeAgo(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const diff = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
  return date.toLocaleDateString();
}

interface VideoItemProps {
  video: Video;
  actions?: {
    onAddToQueue?: (videoId: string) => void;
    onAddToPlaylist?: (video: Video) => void;
    onRemove?: () => void;
    onMarkWatched?: (videoId: string) => void;
    showDragHandle?: boolean;
  };
  dragListeners?: SyntheticListenerMap;
}

const VideoItem = React.memo(function VideoItem({ video, actions, dragListeners }: VideoItemProps) {
  const progress = video.playback_progress ?? 0;
  const isWatched = progress >= 95;

  return (
    <div className={`video-item${isWatched ? ' watched' : ''}`}>
      <div className="video-thumbnail">
        {video.thumbnail_url ? (
          <img
            src={video.thumbnail_url}
            alt={video.title}
            loading="lazy"
            onError={(e) => {
              const img = e.currentTarget;
              if (video.channel_id) {
                const channelFallback = `/api/subscriptions/${video.channel_id}/thumbnail/`;
                if (!img.src.endsWith(channelFallback)) {
                  img.src = channelFallback;
                  return;
                }
              }
              img.style.display = 'none';
            }}
          />
        ) : (
          <div style={{ width: '100%', height: '100%', background: '#e0e0e0' }} />
        )}
        {video.duration_seconds != null && video.duration_seconds > 0 && (
          <span className="duration-badge">{formatDuration(video.duration_seconds)}</span>
        )}
        {progress > 0 && (
          <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
        )}
      </div>
      <div className="video-info">
        <a
          className="video-title"
          href={`https://www.youtube.com/watch?v=${video.video_id}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          {video.title}
        </a>
        {video.channel_title && (
          <div className="video-channel">{video.channel_title}</div>
        )}
        {video.published_at && (
          <div className="video-meta">{timeAgo(video.published_at)}</div>
        )}
        <div className="video-actions">
          {actions?.showDragHandle && (
            <span className="drag-handle" {...(dragListeners ?? {})}>
              <DragIndicator style={{ fontSize: '1rem' }} />
            </span>
          )}
          {actions?.onMarkWatched && progress < 95 && (
            <button
              className="btn-action btn-action-reveal"
              title="Mark as watched"
              onClick={(e) => { e.stopPropagation(); actions.onMarkWatched!(video.video_id); }}
            >
              <Visibility style={{ fontSize: '1rem' }} />
            </button>
          )}
          {actions?.onAddToQueue && (
            <button
              className="btn-action btn-action-reveal"
              title="Add to queue"
              onClick={(e) => { e.stopPropagation(); actions.onAddToQueue!(video.video_id); }}
            >
              <PlaylistAdd style={{ fontSize: '1rem' }} />
            </button>
          )}
          {actions?.onAddToPlaylist && (
            <button
              className="btn-action btn-action-reveal"
              title="Add to playlist"
              onClick={(e) => { e.stopPropagation(); actions.onAddToPlaylist!(video); }}
            >
              <PlaylistAddCheck style={{ fontSize: '1rem' }} />
            </button>
          )}
          {actions?.onRemove && (
            <button
              className="btn-action btn-action-danger btn-action-reveal"
              title="Remove"
              onClick={(e) => { e.stopPropagation(); actions.onRemove!(); }}
            >
              <Close style={{ fontSize: '1rem' }} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

export default VideoItem;
