import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, act } from '@testing-library/react';
import { renderWithProviders } from '../../../test/helpers';
import Toast from '../Toast';
import { AppProvider, useAppContext } from '../../../context/AppContext';
import { render } from '@testing-library/react';

// Helper component to dispatch toast actions
function ToastTrigger({ message, type }: { message: string; type: 'success' | 'error' | 'info' }) {
  const { dispatch } = useAppContext();
  return (
    <button onClick={() => dispatch({ type: 'SHOW_TOAST', message, toastType: type })}>
      Show Toast
    </button>
  );
}

function renderToastWithTrigger(message: string, type: 'success' | 'error' | 'info' = 'success') {
  return render(
    <AppProvider>
      <ToastTrigger message={message} type={type} />
      <Toast />
    </AppProvider>
  );
}

describe('Toast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders toast message with correct variant class', async () => {
    renderToastWithTrigger('Operation succeeded', 'success');
    await act(async () => {
      screen.getByText('Show Toast').click();
    });
    expect(screen.getByText('Operation succeeded')).toBeInTheDocument();
    // Success variant uses bg-success class
    const toastEl = screen.getByText('Operation succeeded').closest('.toast');
    expect(toastEl).toHaveClass('bg-success');
  });

  it('auto-dismisses after timeout', async () => {
    renderToastWithTrigger('Will disappear', 'error');
    await act(async () => {
      screen.getByText('Show Toast').click();
    });
    expect(screen.getByText('Will disappear')).toBeInTheDocument();

    // Advance past the 4 second timeout
    await act(async () => {
      vi.advanceTimersByTime(4100);
    });
    expect(screen.queryByText('Will disappear')).not.toBeInTheDocument();
  });

  it("doesn't render when toast is null", () => {
    renderWithProviders(<Toast />);
    // No toast elements should be rendered
    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
    expect(document.querySelector('.toast')).not.toBeInTheDocument();
  });
});
