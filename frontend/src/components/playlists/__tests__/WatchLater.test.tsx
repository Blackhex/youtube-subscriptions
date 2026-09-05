import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as api from '../../../api/client';
import { mockVideo, renderWithProviders } from '../../../test/helpers';
import type { Playlist } from '../../../types';
import PlaylistColumn from '../PlaylistColumn';
import PlaylistsSection from '../PlaylistsSection';
import AddToPlaylistModal from '../../feeds/AddToPlaylistModal';

vi.mock('../../../api/client');
vi.mock('../../../hooks/useCast', () => ({
  useCast: () => ({ castAvailable: false, requestCastSession: vi.fn(), castPlaylist: vi.fn() }),
}));

const watchLater: Playlist = {
  id: 'WL', title: 'Watch Later', description: '', thumbnail_url: null,
  privacy_status: 'private', item_count: null, read_only: true,
};
const normal: Playlist = { ...watchLater, id: 'PL_normal', title: 'Normal', item_count: 1, read_only: false };
const video = mockVideo({ playlist_item_id: 'item-one' });
const props = {
  playlist: watchLater, items: [video], hasMore: false, loading: false,
  onLoadMore: vi.fn(), onRemoveItem: vi.fn(), onReorder: vi.fn(), onDelete: vi.fn(),
  onCast: vi.fn(), castAvailable: true, confirm: vi.fn(), onRetry: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.fetchPlaylists).mockResolvedValue({ data: [watchLater, normal] } as never);
  vi.mocked(api.fetchPlaylistItems).mockResolvedValue({ data: {
    items: [video], page: 1, has_more: false, next_page_token: null,
  } } as never);
});

describe('Watch Later', () => {
  it('renders a regular column without unsupported mutation controls', () => {
    const { container } = render(<PlaylistColumn {...props} />);
    expect(screen.getByRole('heading', { name: 'Watch Later' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: video.title })).toHaveAttribute('href',
      `https://www.youtube.com/watch?v=${video.video_id}`);
    expect(screen.getByText('1 items')).toBeInTheDocument();
    expect(screen.queryByTitle('Delete playlist')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Remove')).not.toBeInTheDocument();
    expect(container.querySelector('.drag-handle')).toBeNull();
    fireEvent.click(screen.getByTitle('Cast playlist'));
    expect(props.onCast).toHaveBeenCalledWith('WL');
  });

  it('keeps normal playlist edit controls', () => {
    const { container } = render(<PlaylistColumn {...props} playlist={normal} />);
    expect(screen.getByTitle('Delete playlist')).toBeInTheDocument();
    expect(screen.getByTitle('Remove')).toBeInTheDocument();
    expect(container.querySelector('.drag-handle')).not.toBeNull();
  });

  it('does not present a failure or loading state as an empty playlist', () => {
    const { rerender } = render(<PlaylistColumn {...props} items={[]} loading />);
    expect(screen.queryByText('0 items')).not.toBeInTheDocument();
    rerender(<PlaylistColumn {...props} items={[]} error="Watch Later is unavailable." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Watch Later is unavailable.');
    expect(screen.queryByText('No items')).not.toBeInTheDocument();
    expect(screen.queryByText('0 items')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Retry loading playlist'));
    expect(props.onRetry).toHaveBeenCalledOnce();
  });

  it('shows a lower-bound count until the last page', () => {
    render(<PlaylistColumn {...props} hasMore />);
    expect(screen.getByText('1+ items')).toBeInTheDocument();
  });

  it('places Watch Later first and loads its items through the regular endpoint', async () => {
    renderWithProviders(<PlaylistsSection confirm={vi.fn()} />);
    await screen.findByRole('heading', { name: 'Normal' });
    expect(screen.getAllByRole('heading').map((heading) => heading.textContent))
      .toEqual(['Watch Later', 'Normal']);
    await waitFor(() => expect(api.fetchPlaylistItems).toHaveBeenCalledWith('WL', {
      per_page: 20, page_token: undefined,
    }));
  });

  it('retries a failed initial Watch Later page without removing normal playlists', async () => {
    vi.mocked(api.fetchPlaylistItems).mockRejectedValueOnce(new Error('Unavailable'));
    renderWithProviders(<PlaylistsSection confirm={vi.fn()} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Watch Later is unavailable');
    expect(screen.getByRole('heading', { name: 'Normal' })).toBeInTheDocument();
    fireEvent.click(within(alert).getByTitle('Retry loading playlist'));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(vi.mocked(api.fetchPlaylistItems).mock.calls.filter(([id]) => id === 'WL')).toHaveLength(2);
  });

  it('excludes Watch Later from writable playlist choices', async () => {
    renderWithProviders(<AddToPlaylistModal video={video} onClose={vi.fn()} />);
    const select = await screen.findByRole('combobox');
    expect(within(select).queryByRole('option', { name: /Watch Later/ })).not.toBeInTheDocument();
    expect(select).toHaveValue('PL_normal');
  });
});