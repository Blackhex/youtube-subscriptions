import { useState, useEffect, useCallback } from 'react';
import { Close } from '@mui/icons-material';
import type { Video, Playlist } from '../../types';
import * as api from '../../api/client';
import { useAppContext } from '../../context/AppContext';

interface AddToPlaylistModalProps {
  video: Video;
  onClose: () => void;
}

export default function AddToPlaylistModal({ video, onClose }: AddToPlaylistModalProps) {
  const { dispatch } = useAppContext();
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.fetchPlaylists().then((res) => {
      const writable = res.data.filter((playlist) => !playlist.read_only);
      setPlaylists(writable);
      if (writable.length > 0) {
        setSelectedId(writable[0].id);
      }
    }).catch(() => {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to load playlists', toastType: 'error' });
    });
  }, [dispatch]);

  const handleAdd = useCallback(async () => {
    if (!selectedId) return;
    setLoading(true);
    try {
      await api.addToPlaylist(selectedId, video.video_id);
      const playlist = playlists.find((p) => p.id === selectedId);
      dispatch({ type: 'SHOW_TOAST', message: `Added to ${playlist?.title ?? 'playlist'}`, toastType: 'success' });
      onClose();
    } catch {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to add to playlist', toastType: 'error' });
    } finally {
      setLoading(false);
    }
  }, [selectedId, video.video_id, playlists, dispatch, onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Add to Playlist</h3>
          <button className="btn-action" onClick={onClose}>
            <Close />
          </button>
        </div>
        <div className="modal-body">
          <p style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.75rem' }}>
            {video.title}
          </p>
          <div className="form-group">
            <label>Select Playlist</label>
            {playlists.length === 0 ? (
              <p style={{ fontSize: '0.8rem', color: 'var(--md-text-meta)' }}>No playlists found</p>
            ) : (
              <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
                {playlists.map((pl) => (
                  <option key={pl.id} value={pl.id}>
                    {pl.title} ({pl.item_count} items)
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={handleAdd}
            disabled={!selectedId || loading}
          >
            {loading ? 'Adding...' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}
