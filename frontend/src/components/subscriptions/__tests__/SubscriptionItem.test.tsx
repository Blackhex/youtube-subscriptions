import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SubscriptionItem from '../SubscriptionItem';
import { mockSubscription } from '../../../test/helpers';

describe('SubscriptionItem', () => {
  const defaultProps = {
    isSelected: false,
    isActive: false,
    onToggleSelection: vi.fn(),
    onShowVideos: vi.fn(),
    onDelete: vi.fn(),
  };

  it('renders channel title and description', () => {
    const sub = mockSubscription({
      channel_title: 'Awesome Channel',
      channel_description: 'Videos about coding',
    });
    render(<SubscriptionItem subscription={sub} {...defaultProps} />);
    expect(screen.getByText('Awesome Channel')).toBeInTheDocument();
    expect(screen.getByText('Videos about coding')).toBeInTheDocument();
  });

  it('renders category badges', () => {
    const sub = mockSubscription({
      categories: [
        { id: 1, name: 'Tech' },
        { id: 2, name: 'Gaming' },
      ],
    });
    render(<SubscriptionItem subscription={sub} {...defaultProps} />);
    expect(screen.getByText('Tech')).toBeInTheDocument();
    expect(screen.getByText('Gaming')).toBeInTheDocument();
  });

  it('shows delete button', () => {
    const onDelete = vi.fn();
    const sub = mockSubscription({ id: 42 });
    render(<SubscriptionItem subscription={sub} {...defaultProps} onDelete={onDelete} />);
    const deleteBtn = screen.getByTitle('Unsubscribe');
    expect(deleteBtn).toBeInTheDocument();
    fireEvent.click(deleteBtn);
    expect(onDelete).toHaveBeenCalledWith(42);
  });

  it('selection button reflects selected state', () => {
    const sub = mockSubscription();
    const { container, rerender } = render(
      <SubscriptionItem subscription={sub} {...defaultProps} isSelected={false} />
    );
    expect(screen.getByRole('button', { name: 'Select' })).toBeInTheDocument();
    expect(container.querySelector('.subscription-item')).not.toHaveClass('selected');

    rerender(
      <SubscriptionItem subscription={sub} {...defaultProps} isSelected={true} />
    );
    expect(screen.getByRole('button', { name: 'Deselect' })).toBeInTheDocument();
    expect(container.querySelector('.subscription-item')).toHaveClass('selected');
  });
});
