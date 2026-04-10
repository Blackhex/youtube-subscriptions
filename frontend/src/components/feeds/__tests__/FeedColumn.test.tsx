import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import FeedColumn from '../FeedColumn';
import { mockFeed, mockVideo } from '../../../test/helpers';
import type { Feed } from '../../../types';

const feed = mockFeed({ id: 7, name: 'Music' });

function renderFeedColumn(overrides: { feed?: Feed; onEdit?: () => void } = {}) {
  const currentFeed = overrides.feed ?? feed;
  const onEdit = overrides.onEdit ?? vi.fn();

  render(
    <DndContext>
      <SortableContext items={[currentFeed.id]} strategy={horizontalListSortingStrategy}>
        <FeedColumn
          feed={currentFeed}
          videos={[mockVideo({ id: 1, video_id: 'v-1' })]}
          hasMore={false}
          loading={false}
          categories={[]}
          onLoadMore={vi.fn()}
          onEdit={onEdit}
          onAddToQueue={vi.fn()}
          onAddToPlaylist={vi.fn()}
          onMarkWatched={vi.fn()}
        />
      </SortableContext>
    </DndContext>,
  );

  return { onEdit };
}

describe('FeedColumn drag handle', () => {
  it('keeps the feed name reachable as a heading', () => {
    renderFeedColumn();

    expect(screen.getByRole('heading', { name: feed.name })).toBeInTheDocument();
  });

  it('exposes the drag handle inside the title without polluting the heading name', () => {
    renderFeedColumn();

    const heading = screen.getByRole('heading', { name: feed.name });
    const handle = screen.getByText(feed.name);
    expect(handle).toHaveClass('feed-title-handle');
    expect(handle).not.toHaveAttribute('aria-label');
    expect(handle).toHaveAttribute('aria-roledescription', 'sortable');
    expect(heading).toContainElement(handle);
  });

  it('still fires onEdit when the edit button is clicked', () => {
    const { onEdit } = renderFeedColumn();

    fireEvent.click(screen.getByTitle('Edit feed'));

    expect(onEdit).toHaveBeenCalledOnce();
  });
});
