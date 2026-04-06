import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../../../test/helpers';
import Navbar from '../Navbar';

const defaultProps = {
  onNewFeed: vi.fn(),
  onNewCategory: vi.fn(),
  onAISuggestions: vi.fn(),
  onExport: vi.fn(),
  onImport: vi.fn(),
  onSync: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Navbar', () => {
  it('renders all three section tabs', () => {
    renderWithProviders(<Navbar {...defaultProps} />);
    expect(screen.getByText('Feeds')).toBeInTheDocument();
    expect(screen.getByText('Playlists')).toBeInTheDocument();
    expect(screen.getByText('Subscriptions')).toBeInTheDocument();
  });

  it('switches activeSection on tab click', () => {
    renderWithProviders(<Navbar {...defaultProps} />);
    const subsTab = screen.getByText('Subscriptions');
    fireEvent.click(subsTab);
    // After click, the Subscriptions tab should become active
    expect(subsTab.className).toContain('active');
  });

  it('shows correct action buttons per section', () => {
    // Default section is 'feeds', should show "New Feed" button
    const { unmount } = renderWithProviders(<Navbar {...defaultProps} />);
    expect(screen.getByTitle('New Feed')).toBeInTheDocument();
    expect(screen.queryByTitle('New Category')).not.toBeInTheDocument();
    unmount();

    // Switch to subscriptions section and verify its buttons
    renderWithProviders(<Navbar {...defaultProps} />);
    fireEvent.click(screen.getByText('Subscriptions'));
    expect(screen.getByTitle('New Category')).toBeInTheDocument();
    expect(screen.getByTitle('AI Suggestions')).toBeInTheDocument();
    expect(screen.getByTitle('Export')).toBeInTheDocument();
    expect(screen.getByTitle('Import')).toBeInTheDocument();
    expect(screen.queryByTitle('New Feed')).not.toBeInTheDocument();
  });
});
