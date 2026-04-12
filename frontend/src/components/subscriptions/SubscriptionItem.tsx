import React from 'react';
import { CheckBox, CheckBoxOutlineBlank, Delete } from '@mui/icons-material';

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
  isActive: boolean;
  onToggleSelection: (id: number) => void;
  onShowVideos: (channelId: string, channelTitle: string) => void;
  onDelete: (id: number) => void;
}

export default React.memo(function SubscriptionItem({
  subscription,
  isSelected,
  isActive,
  onToggleSelection,
  onShowVideos,
  onDelete,
}: SubscriptionItemProps) {
  return (
    <div
      className={`subscription-item${isSelected ? ' selected' : ''}${isActive ? ' active' : ''}`}
      onClick={() => onShowVideos(subscription.channel_id, subscription.channel_title)}
    >
      <img
        className="subscription-thumbnail"
        src={subscription.thumbnail_url || '/placeholder-channel.png'}
        alt={subscription.channel_title}
        loading="lazy"
      />
      <div className="subscription-info">
        <a
          className="subscription-title"
          href={`https://www.youtube.com/channel/${subscription.channel_id}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          title="Open channel on YouTube"
        >
          {subscription.channel_title}
        </a>
        {subscription.channel_description && (
          <p className="subscription-desc">{subscription.channel_description}</p>
        )}
        <div className="subscription-actions">
          <button
            className="btn-action btn-action-reveal"
            title={isSelected ? 'Deselect' : 'Select'}
            onClick={(e) => { e.stopPropagation(); onToggleSelection(subscription.id); }}
          >
            {isSelected ? <CheckBox fontSize="small" /> : <CheckBoxOutlineBlank fontSize="small" />}
          </button>
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
      </div>
      {subscription.categories.length > 0 && (
        <div className="subscription-badges">
          {subscription.categories.map((cat) => (
            <span key={cat.id} className="category-badge">
              {cat.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
});
