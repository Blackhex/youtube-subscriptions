import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import VideoItem, { formatDuration } from '../VideoItem';
import { mockVideo } from '../../../test/helpers';

describe('VideoItem', () => {
  it('renders video title and channel name', () => {
    const video = mockVideo({ title: 'My Great Video', channel_title: 'Best Channel' });
    render(<VideoItem video={video} />);
    expect(screen.getByText('My Great Video')).toBeInTheDocument();
    expect(screen.getByText('Best Channel')).toBeInTheDocument();
  });

  it('shows duration badge for videos with duration', () => {
    const video = mockVideo({ duration_seconds: 754 });
    render(<VideoItem video={video} />);
    // 754 seconds = 12:34
    expect(screen.getByText('12:34')).toBeInTheDocument();
  });

  it('shows progress bar for partially watched', () => {
    const video = mockVideo({ playback_progress: 50 });
    const { container } = render(<VideoItem video={video} />);
    const progressBar = container.querySelector('.progress-bar-fill');
    expect(progressBar).toBeInTheDocument();
    expect(progressBar).toHaveStyle({ width: '50%' });
  });

  it('applies watched class at ≥95% progress', () => {
    const video = mockVideo({ playback_progress: 97 });
    const { container } = render(<VideoItem video={video} />);
    expect(container.querySelector('.video-item')).toHaveClass('watched');
  });

  it('formatDuration: formats seconds correctly (H:MM:SS, M:SS)', () => {
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3661)).toBe('1:01:01');
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(59)).toBe('0:59');
    expect(formatDuration(3600)).toBe('1:00:00');
  });
});
