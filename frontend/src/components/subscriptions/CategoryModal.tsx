import { useState } from 'react';
import type { Category } from '../../types';

interface CategoryModalProps {
  category?: Category;
  parentId?: number | null;
  allCategories: Category[];
  onSave: (data: { name: string; description?: string; parent_id: number | null }) => void;
  onClose: () => void;
}

function flattenCategories(categories: Category[], excludeId?: number, depth = 0): { id: number; name: string; depth: number }[] {
  const result: { id: number; name: string; depth: number }[] = [];
  for (const cat of categories) {
    if (cat.id === excludeId) continue;
    result.push({ id: cat.id, name: cat.name, depth });
    // Exclude descendants of the category being edited
    if (excludeId) {
      const isDescendant = (c: Category): boolean => {
        if (c.id === excludeId) return true;
        return c.children.some(isDescendant);
      };
      if (!cat.children.some(isDescendant)) {
        result.push(...flattenCategories(cat.children, excludeId, depth + 1));
      }
    } else {
      result.push(...flattenCategories(cat.children, excludeId, depth + 1));
    }
  }
  return result;
}

export default function CategoryModal({ category, parentId, allCategories, onSave, onClose }: CategoryModalProps) {
  const [name, setName] = useState(category?.name || '');
  const [description, setDescription] = useState(category?.description || '');
  const [selectedParentId, setSelectedParentId] = useState<number | null>(
    category ? category.parent_id : (parentId ?? null)
  );

  const flatCats = flattenCategories(allCategories, category?.id);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSave({
      name: name.trim(),
      description: description.trim() || undefined,
      parent_id: selectedParentId,
    });
  };

  return (
    <div className="modal d-block" tabIndex={-1} style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
      <div className="modal-dialog modal-dialog-centered">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title">{category ? 'Edit Category' : 'New Category'}</h5>
            <button type="button" className="btn-close" onClick={onClose} />
          </div>
          <form onSubmit={handleSubmit}>
            <div className="modal-body">
              <div className="form-group">
                <label htmlFor="cat-name">Name</label>
                <input
                  id="cat-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="cat-desc">Description</label>
                <textarea
                  id="cat-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                />
              </div>
              <div className="form-group">
                <label htmlFor="cat-parent">Parent Category</label>
                <select
                  id="cat-parent"
                  value={selectedParentId ?? ''}
                  onChange={(e) => setSelectedParentId(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">None (top-level)</option>
                  {flatCats.map((c) => (
                    <option key={c.id} value={c.id}>
                      {'  '.repeat(c.depth) + c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary btn-sm" disabled={!name.trim()}>
                {category ? 'Save' : 'Create'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
