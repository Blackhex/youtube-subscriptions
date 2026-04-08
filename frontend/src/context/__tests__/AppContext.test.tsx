import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { AppProvider, useAppContext } from '../AppContext';
import type { AppAction } from '../AppContext';
import type { SyncState } from '../../types';

// Helper component that renders state and provides a dispatch button
function TestConsumer({ action }: { action?: AppAction }) {
  const { state, dispatch } = useAppContext();
  return (
    <div>
      <div data-testid="activeSection">{state.activeSection}</div>
      <div data-testid="categoryCount">{state.categories.length}</div>
      <div data-testid="selectedIds">{JSON.stringify(state.selectedSubscriptionIds)}</div>
      <div data-testid="syncRunning">{String(state.syncState.running)}</div>
      {action && (
        <button onClick={() => dispatch(action)}>dispatch</button>
      )}
    </div>
  );
}

function renderWithAction(action?: AppAction) {
  return render(
    <AppProvider>
      <TestConsumer action={action} />
    </AppProvider>
  );
}

describe('AppContext', () => {
  it('provides default state', () => {
    renderWithAction();
    expect(screen.getByTestId('activeSection')).toHaveTextContent('feeds');
    expect(screen.getByTestId('categoryCount')).toHaveTextContent('0');
    expect(screen.getByTestId('selectedIds')).toHaveTextContent('[]');
    expect(screen.getByTestId('syncRunning')).toHaveTextContent('false');
  });

  it('SET_CATEGORIES updates categories tree', () => {
    const categories = [
      { id: 1, name: 'Cat1', description: null, parent_id: null, sort_order: 0, subscription_count: 5, children: [], created_at: '', updated_at: '' },
      { id: 2, name: 'Cat2', description: null, parent_id: null, sort_order: 1, subscription_count: 3, children: [], created_at: '', updated_at: '' },
    ];
    const action: AppAction = { type: 'SET_CATEGORIES', categories, totalCount: 100, uncategorizedCount: 10 };
    renderWithAction(action);
    act(() => { screen.getByText('dispatch').click(); });
    expect(screen.getByTestId('categoryCount')).toHaveTextContent('2');
  });

  it('TOGGLE_SELECTION adds/removes subscription IDs', () => {
    // We'll need a more dynamic component
    function ToggleTest() {
      const { state, dispatch } = useAppContext();
      return (
        <div>
          <div data-testid="ids">{JSON.stringify(state.selectedSubscriptionIds)}</div>
          <button onClick={() => dispatch({ type: 'TOGGLE_SELECTION', id: 5 })}>toggle5</button>
          <button onClick={() => dispatch({ type: 'TOGGLE_SELECTION', id: 10 })}>toggle10</button>
        </div>
      );
    }
    render(
      <AppProvider>
        <ToggleTest />
      </AppProvider>
    );
    expect(screen.getByTestId('ids')).toHaveTextContent('[]');
    act(() => { screen.getByText('toggle5').click(); });
    expect(screen.getByTestId('ids')).toHaveTextContent('[5]');
    act(() => { screen.getByText('toggle10').click(); });
    expect(screen.getByTestId('ids')).toHaveTextContent('[5,10]');
    // Toggle 5 again to remove
    act(() => { screen.getByText('toggle5').click(); });
    expect(screen.getByTestId('ids')).toHaveTextContent('[10]');
  });

  it('SET_ACTIVE_SECTION changes section', () => {
    const action: AppAction = { type: 'SET_ACTIVE_SECTION', section: 'subscriptions' };
    renderWithAction(action);
    expect(screen.getByTestId('activeSection')).toHaveTextContent('feeds');
    act(() => { screen.getByText('dispatch').click(); });
    expect(screen.getByTestId('activeSection')).toHaveTextContent('subscriptions');
  });

  it('SET_SYNC_STATE updates sync state', () => {
    const syncState: SyncState = {
      running: true,
      phase: 'subscriptions',
      total: 100,
      processed: 50,
      fetched_new: 10,
      errors: 0,
      skipped: 0,
      subs_synced: 50,
      started_at: '2026-01-01T00:00:00Z',
      finished_at: null,
      current_channel: 'TestChannel',
    };
    const action: AppAction = { type: 'SET_SYNC_STATE', state: syncState };
    renderWithAction(action);
    act(() => { screen.getByText('dispatch').click(); });
    expect(screen.getByTestId('syncRunning')).toHaveTextContent('true');
  });
});
