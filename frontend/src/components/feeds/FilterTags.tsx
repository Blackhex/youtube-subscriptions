import type { Feed, Category } from '../../types';

interface FilterTagsProps {
  feed: Feed;
  categories: Category[];
}

function flattenCategories(cats: Category[]): Category[] {
  const result: Category[] = [];
  for (const cat of cats) {
    result.push(cat);
    if (cat.children?.length) {
      result.push(...flattenCategories(cat.children));
    }
  }
  return result;
}

export default function FilterTags({ feed, categories }: FilterTagsProps) {
  const allCats = flattenCategories(categories);
  const catMap = new Map(allCats.map((c) => [c.id, c.name]));

  const tags: string[] = [];

  // Category filters
  if (feed.filter_category_ids && feed.filter_category_ids.length > 0) {
    feed.filter_category_ids.forEach((group, i) => {
      const names = group.map((id) => catMap.get(id) ?? `#${id}`).join(' or ');
      if (i > 0) tags.push('AND');
      tags.push(names);
    });
  }

  if (feed.filter_video_type) {
    const typeLabels: Record<string, string> = { video: 'Regular', short: 'Shorts', live: 'Live', upcoming: 'Upcoming' };
    const types = feed.filter_video_type.split(',').map(t => t.trim()).filter(Boolean);
    const labels = types.map(t => typeLabels[t] ?? t);
    tags.push(labels.join(', '));
  }

  if (feed.filter_min_duration != null || feed.filter_max_duration != null) {
    const min = feed.filter_min_duration != null ? `${Math.round(feed.filter_min_duration / 60)}min` : '';
    const max = feed.filter_max_duration != null ? `${Math.round(feed.filter_max_duration / 60)}min` : '';
    if (min && max) {
      tags.push(`${min}–${max}`);
    } else if (min) {
      tags.push(`≥${min}`);
    } else {
      tags.push(`≤${max}`);
    }
  }

  if (feed.filter_max_age_days != null) {
    tags.push(`≤${feed.filter_max_age_days}d`);
  }

  if (feed.filter_play_state === 'unplayed') {
    tags.push('Unplayed');
  } else if (feed.filter_play_state === 'played') {
    tags.push('Played');
  }

  if (tags.length === 0) return null;

  return (
    <div className="filter-tags">
      {tags.map((tag, i) => (
        <span key={i} className={`filter-tag${tag === 'AND' ? ' filter-tag-and' : ''}`}>
          {tag}
        </span>
      ))}
    </div>
  );
}
