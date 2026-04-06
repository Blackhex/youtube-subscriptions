import { useState, useCallback, useMemo } from 'react';
import { Close, Add } from '@mui/icons-material';
import type { Feed, Category } from '../../types';

interface FeedModalProps {
  feed?: Feed;
  categories: Category[];
  onSave: (data: Partial<Feed>) => void;
  onDelete?: () => void;
  onClose: () => void;
}

function flattenWithDepth(cats: Category[], depth = 0): { cat: Category; depth: number }[] {
  const result: { cat: Category; depth: number }[] = [];
  for (const cat of cats) {
    result.push({ cat, depth });
    if (cat.children?.length) {
      result.push(...flattenWithDepth(cat.children, depth + 1));
    }
  }
  return result;
}

export default function FeedModal({ feed, categories, onSave, onDelete, onClose }: FeedModalProps) {
  const [name, setName] = useState(feed?.name ?? '');
  const [categoryGroups, setCategoryGroups] = useState<number[][]>(
    feed?.filter_category_ids?.length ? feed.filter_category_ids : [[]]
  );
  const [videoType, setVideoType] = useState<string>(feed?.filter_video_type ?? '');
  const [minDuration, setMinDuration] = useState<string>(
    feed?.filter_min_duration != null ? String(Math.round(feed.filter_min_duration / 60)) : ''
  );
  const [maxDuration, setMaxDuration] = useState<string>(
    feed?.filter_max_duration != null ? String(Math.round(feed.filter_max_duration / 60)) : ''
  );
  const [maxAgeDays, setMaxAgeDays] = useState<string>(
    feed?.filter_max_age_days != null ? String(feed.filter_max_age_days) : ''
  );
  const [playState, setPlayState] = useState<'both' | 'played' | 'unplayed'>(
    feed?.filter_play_state ?? 'both'
  );

  const flatCats = useMemo(() => flattenWithDepth(categories), [categories]);

  const handleGroupToggle = useCallback((groupIndex: number, catId: number) => {
    setCategoryGroups((prev) => {
      const newGroups = prev.map((g) => [...g]);
      const group = newGroups[groupIndex];
      const idx = group.indexOf(catId);
      if (idx >= 0) {
        group.splice(idx, 1);
      } else {
        group.push(catId);
      }
      return newGroups;
    });
  }, []);

  const addGroup = useCallback(() => {
    setCategoryGroups((prev) => [...prev, []]);
  }, []);

  const removeGroup = useCallback((index: number) => {
    setCategoryGroups((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSubmit = useCallback(() => {
    if (!name.trim()) return;

    const filterCategoryIds = categoryGroups.filter((g) => g.length > 0);
    const data: Partial<Feed> = {
      name: name.trim(),
      filter_category_ids: filterCategoryIds.length > 0 ? filterCategoryIds : null,
      filter_video_type: videoType || null,
      filter_min_duration: minDuration ? Number(minDuration) * 60 : null,
      filter_max_duration: maxDuration ? Number(maxDuration) * 60 : null,
      filter_max_age_days: maxAgeDays ? Number(maxAgeDays) : null,
      filter_play_state: playState,
    };

    onSave(data);
  }, [name, categoryGroups, videoType, minDuration, maxDuration, maxAgeDays, playState, onSave]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: 550 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{feed ? 'Edit Feed' : 'New Feed'}</h3>
          <button className="btn-action" onClick={onClose}>
            <Close />
          </button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label>Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Feed name"
              autoFocus
            />
          </div>

          <div className="form-group">
            <label>Categories (AND/OR groups)</label>
            {categoryGroups.map((group, gi) => (
              <div key={gi} className="category-group">
                <div className="category-group-header">
                  <span>{gi === 0 ? 'Match any of:' : 'AND match any of:'}</span>
                  {categoryGroups.length > 1 && (
                    <button className="btn-action btn-action-sm btn-action-danger" onClick={() => removeGroup(gi)}>
                      <Close style={{ fontSize: '0.85rem' }} />
                    </button>
                  )}
                </div>
                {flatCats.map(({ cat, depth }) => (
                  <label key={cat.id} className="category-checkbox" style={{ marginLeft: `${depth * 16}px` }}>
                    <input
                      type="checkbox"
                      checked={group.includes(cat.id)}
                      onChange={() => handleGroupToggle(gi, cat.id)}
                    />
                    <span>{cat.name}</span>
                  </label>
                ))}
              </div>
            ))}
            <button className="btn btn-sm btn-secondary mt-1" onClick={addGroup}>
              <Add style={{ fontSize: '0.85rem', marginRight: 2 }} />
              Add AND group
            </button>
          </div>

          <div className="form-group">
            <label>Video Type</label>
            <select value={videoType} onChange={(e) => setVideoType(e.target.value)}>
              <option value="">All</option>
              <option value="video">Regular Videos</option>
              <option value="short">Shorts</option>
              <option value="live">Live</option>
            </select>
          </div>

          <div className="form-group">
            <label>Duration (minutes)</label>
            <div className="d-flex gap-2 align-items-center">
              <input
                type="number"
                min="0"
                value={minDuration}
                onChange={(e) => setMinDuration(e.target.value)}
                placeholder="Min"
                style={{ width: '50%' }}
              />
              <span>–</span>
              <input
                type="number"
                min="0"
                value={maxDuration}
                onChange={(e) => setMaxDuration(e.target.value)}
                placeholder="Max"
                style={{ width: '50%' }}
              />
            </div>
          </div>

          <div className="form-group">
            <label>Max Age (days)</label>
            <input
              type="number"
              min="0"
              value={maxAgeDays}
              onChange={(e) => setMaxAgeDays(e.target.value)}
              placeholder="e.g. 14"
            />
          </div>

          <div className="form-group">
            <label>Play State</label>
            <div className="d-flex gap-3">
              {(['both', 'unplayed', 'played'] as const).map((ps) => (
                <label key={ps} className="d-flex align-items-center gap-1" style={{ fontSize: '0.85rem' }}>
                  <input
                    type="radio"
                    name="playState"
                    checked={playState === ps}
                    onChange={() => setPlayState(ps)}
                  />
                  {ps.charAt(0).toUpperCase() + ps.slice(1)}
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="modal-footer">
          {feed && onDelete && (
            <button className="btn btn-danger btn-delete" onClick={onDelete}>
              Delete
            </button>
          )}
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={!name.trim()}>
            {feed ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
