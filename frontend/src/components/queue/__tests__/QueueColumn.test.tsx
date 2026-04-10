import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import QueueColumn from '../QueueColumn';
import { mockQueueItem } from '../../../test/helpers';

describe('QueueColumn Cast feedback', () => {
  it('shows a spinner and blocks repeat clicks until casting finishes', async () => {
    let finishCasting: (() => void) | undefined;
    const onCast = vi.fn(() => new Promise<void>((resolve) => {
      finishCasting = resolve;
    }));

    render(
      <QueueColumn
        queueItems={[mockQueueItem()]}
        onRemove={vi.fn()}
        onReorder={vi.fn()}
        onCreatePlaylist={vi.fn()}
        onCast={onCast}
        castAvailable
      />,
    );

    const button = screen.getByTitle('Cast queue to device');
    fireEvent.click(button);

    expect(onCast).toHaveBeenCalledOnce();
    expect(screen.getByTitle('Casting queue...')).toBeDisabled();
    expect(screen.getByRole('status', { name: 'Casting queue' })).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Casting queue...'));
    expect(onCast).toHaveBeenCalledOnce();

    finishCasting?.();

    await waitFor(() => {
      expect(screen.getByTitle('Cast queue to device')).toBeEnabled();
    });
    expect(screen.queryByRole('status', { name: 'Casting queue' })).not.toBeInTheDocument();
  });
});