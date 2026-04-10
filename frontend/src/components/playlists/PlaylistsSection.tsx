import { useEffect, useCallback } from 'react';
import { usePlaylists } from '../../hooks/usePlaylists';
import { useCast } from '../../hooks/useCast';
import PlaylistColumn from './PlaylistColumn';

interface PlaylistsSectionProps {
  confirm: (opts: { title: string; message: string }) => Promise<boolean>;
}

export default function PlaylistsSection({ confirm }: PlaylistsSectionProps) {
  const {
    playlists,
    playlistItems,
    loading,
    fetchPlaylists,
    fetchPlaylistItems,
    loadMoreItems,
    removeItem,
    reorderItems,
    deletePlaylist,
  } = usePlaylists();

  const { castAvailable, requestCastSession, castPlaylist } = useCast();

  useEffect(() => {
    fetchPlaylists();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch items for each playlist once playlists are loaded
  useEffect(() => {
    for (const playlist of playlists) {
      if (!playlistItems[playlist.id]) {
        fetchPlaylistItems(playlist.id);
      }
    }
  }, [playlists]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCast = useCallback(async (playlistId: string) => {
    const screenId = await requestCastSession();
    if (screenId) {
      await castPlaylist(playlistId, screenId);
    }
  }, [requestCastSession, castPlaylist]);

  return (
    <div className="scrollable-x">
      {playlists.length === 0 && !loading ? (
        <div className="empty-state" style={{ margin: 'auto' }}>
          <p>No playlists found</p>
          <p style={{ fontSize: '0.75rem' }}>Sync to load your YouTube playlists</p>
        </div>
      ) : (
        playlists.map((playlist) => {
          const state = playlistItems[playlist.id];
          return (
            <PlaylistColumn
              key={playlist.id}
              playlist={playlist}
              items={state?.items ?? []}
              hasMore={state?.hasMore ?? true}
              loading={state?.loading ?? false}
              onLoadMore={() => loadMoreItems(playlist.id)}
              onRemoveItem={removeItem}
              onReorder={reorderItems}
              onDelete={deletePlaylist}
              onCast={handleCast}
              castAvailable={castAvailable}
              confirm={confirm}
            />
          );
        })
      )}
    </div>
  );
}
