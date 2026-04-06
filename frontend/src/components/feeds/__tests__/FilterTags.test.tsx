import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import FilterTags from '../FilterTags';
import { mockFeed, mockCategory } from '../../../test/helpers';

const categories = [
  mockCategory({ id: 1, name: 'Tech', children: [] }),
  mockCategory({ id: 2, name: 'Gaming', children: [] }),
  mockCategory({ id: 3, name: 'Music', children: [] }),
];

describe('FilterTags', () => {
  it('renders category name pills', () => {
    const feed = mockFeed({
      filter_category_ids: [[1, 2], [3]],
    });
    render(<FilterTags feed={feed} categories={categories} />);
    // First group: "Tech or Gaming"
    expect(screen.getByText('Tech or Gaming')).toBeInTheDocument();
    // AND connector
    expect(screen.getByText('AND')).toBeInTheDocument();
    // Second group: "Music"
    expect(screen.getByText('Music')).toBeInTheDocument();
  });

  it('renders video type tag', () => {
    const feed = mockFeed({ filter_video_type: 'short' });
    render(<FilterTags feed={feed} categories={categories} />);
    expect(screen.getByText('Shorts')).toBeInTheDocument();
  });

  it('renders play state tag', () => {
    const feed = mockFeed({ filter_play_state: 'unplayed' });
    render(<FilterTags feed={feed} categories={categories} />);
    expect(screen.getByText('Unplayed')).toBeInTheDocument();
  });
});
