import React from 'react';
import { Delete, OpenInNew } from '@mui/icons-material';

interface SubscriptionItemProps {
  subscription: {
    id: number;
    channel_id: string;
    channel_title: string;
    channel_description: string | null;
    thumbnail_url: string | null;
    categories: { id: number; name: string }[];
  };
  isSelected: boolean;
  onToggleSelection: (id: number) => void;
  onDelete: (id: number) => void;
}

export default React.memo(function SubscriptionItem({
  subscription,
  isSelected,
  onToggleSelection,
  onDelete,
}: SubscriptionItemProps) {
  return (
    <div
      className={`subscription-item${isSelected ? ' selected' : ''}`}
      onClick={() => onToggleSelection(subscription.id)}
    >
      <input
        type="checkbox"
        checked={isSelected}
        onChange={() => onToggleSelection(subscription.id)}
        onClick={(e) => e.stopPropagation()}
      />
      <img
        className="subscription-thumbnail"
        src={subscription.thumbnail_url || '/placeholder-channel.png'}
        alt={subscription.channel_title}
        loading="lazy"
      />
      <div
        className="subscription-info"
        onClick={(e) => {
          e.stopPropagation();
          window.open(`https://www.youtube.com/channel/${subscription.channel_id}`, '_blank', 'noopener,noreferrer');
        }}
        style={{ cursor: 'pointer' }}
        title="Open channel on YouTube"
      >
        <p className="subscription-title">
          {subscription.channel_title}
          <OpenInNew sx={{ fontSize: '0.75rem', ml: 0.5, verticalAlign: 'middle', opacity: 0.5 }} />
        </p>
        {subscription.channel_description && (
          <p className="subscription-desc">{subscription.channel_description}</p>
        )}
        {subscription.categories.length > 0 && (
          <div>
            {subscription.categories.map((cat) => (
              <span key={cat.id} className="category-badge">
                {cat.name}
              </span>
            ))}
          </div>
        )}
      </div>
      <button
        className="btn-action btn-action-reveal btn-action-danger"
        title="Unsubscribe"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(subscription.id);
        }}
      >
        <Delete fontSize="small" />
      </button>
    </div>
  );
});
