import { Sync, NoteAdd, CreateNewFolder, AutoAwesome, FileUpload, FileDownload } from '@mui/icons-material';
import { useAppContext } from '../../context/AppContext';
import { useEffect, useState, useCallback, useRef } from 'react';
import * as api from '../../api/client';

interface NavbarProps {
  onNewFeed: () => void;
  onNewCategory: () => void;
  onAISuggestions: () => void;
  onExport: () => void;
  onImport: () => void;
  onSync: () => void;
}

export default function Navbar({ onNewFeed, onNewCategory, onAISuggestions, onExport, onImport, onSync }: NavbarProps) {
  const { state, dispatch } = useAppContext();
  const { activeSection, syncState } = state;

  const [oauthStatus, setOauthStatus] = useState<{
    authenticated: boolean;
    in_progress: boolean;
    auth_url: string | null;
    error: string | null;
  }>({ authenticated: false, in_progress: false, auth_url: null, error: null });

  const authPollRef = useRef<number | null>(null);

  // Check OAuth on mount
  useEffect(() => {
    api.fetchOAuthStatus().then((r) => setOauthStatus(r.data)).catch(() => {});
  }, []);

  // Re-check OAuth when sync finishes
  const prevSyncRunning = useRef(syncState.running);
  useEffect(() => {
    if (prevSyncRunning.current && !syncState.running) {
      api.fetchOAuthStatus().then((r) => {
        setOauthStatus(r.data);
        // If OAuth was auto-started by the failed sync, open the auth URL
        if (r.data.in_progress && r.data.auth_url) {
          window.open(r.data.auth_url, '_blank');
          dispatch({ type: 'SHOW_TOAST', message: 'Sign in to Google to continue', toastType: 'success' });
        }
      }).catch(() => {});
    }
    prevSyncRunning.current = syncState.running;
  }, [syncState.running, dispatch]);

  // Poll while OAuth in_progress
  useEffect(() => {
    if (oauthStatus.in_progress) {
      authPollRef.current = window.setInterval(async () => {
        try {
          const r = await api.fetchOAuthStatus();
          setOauthStatus(r.data);
          if (!r.data.in_progress) {
            if (r.data.authenticated) {
              dispatch({ type: 'SHOW_TOAST', message: 'Google API connected! Starting sync...', toastType: 'success' });
              onSync();
            } else if (r.data.error) {
              dispatch({ type: 'SHOW_TOAST', message: `Sign-in failed: ${r.data.error}`, toastType: 'error' });
            }
          }
        } catch { /* ignore */ }
      }, 2000);
    }
    return () => {
      if (authPollRef.current) {
        clearInterval(authPollRef.current);
        authPollRef.current = null;
      }
    };
  }, [oauthStatus.in_progress, dispatch]);

  // Smart sync click handler
  const handleSyncClick = useCallback(async () => {
    // Step 1: OAuth needed?
    if (!oauthStatus.authenticated) {
      if (oauthStatus.in_progress && oauthStatus.auth_url) {
        // Already in progress — re-open the auth tab
        window.open(oauthStatus.auth_url, '_blank');
        dispatch({ type: 'SHOW_TOAST', message: 'Complete sign-in in the opened tab', toastType: 'success' });
        return;
      }
      if (!oauthStatus.in_progress) {
        // Start OAuth
        try {
          const r = await api.startOAuth();
          setOauthStatus(r.data);
          if (r.data.auth_url) {
            window.open(r.data.auth_url, '_blank');
            dispatch({ type: 'SHOW_TOAST', message: 'Sign in to Google, then click Sync again', toastType: 'success' });
          }
        } catch {
          dispatch({ type: 'SHOW_TOAST', message: 'Failed to start sign-in', toastType: 'error' });
        }
      }
      return;
    }

    // Step 2: OAuth ready — start sync
    onSync();
  }, [oauthStatus, dispatch, onSync]);

  const sections = ['feeds', 'playlists', 'subscriptions'] as const;

  const isBusy = syncState.running || oauthStatus.in_progress;
  const syncTitle = oauthStatus.in_progress
    ? 'Signing in to Google...'
    : !oauthStatus.authenticated
    ? 'Click to sign in to Google'
    : syncState.running
    ? 'Syncing...'
    : 'Sync with YouTube';

  return (
    <nav className="navbar navbar-dark navbar--top">
      <div className="d-flex align-items-center gap-2 w-100 px-3 py-2">
        <ul className="nav nav-pills me-auto">
          {sections.map((s) => (
            <li className="nav-item" key={s}>
              <button
                className={`nav-link${activeSection === s ? ' active' : ''}`}
                onClick={() => dispatch({ type: 'SET_ACTIVE_SECTION', section: s })}
              >
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            </li>
          ))}
        </ul>

        <div className="d-flex align-items-center gap-1">
          {activeSection === 'feeds' && (
            <button className="btn-icon" title="New Feed" onClick={onNewFeed}>
              <NoteAdd fontSize="small" />
            </button>
          )}

          {activeSection === 'subscriptions' && (
            <>
              <button className="btn-icon" title="New Category" onClick={onNewCategory}>
                <CreateNewFolder fontSize="small" />
              </button>
              <button className="btn-icon" title="AI Suggestions" onClick={onAISuggestions}>
                <AutoAwesome fontSize="small" />
              </button>
              <button className="btn-icon" title="Export" onClick={onExport}>
                <FileUpload fontSize="small" />
              </button>
              <button className="btn-icon" title="Import" onClick={onImport}>
                <FileDownload fontSize="small" />
              </button>
            </>
          )}

          <button
            className="btn-icon"
            title={syncTitle}
            onClick={handleSyncClick}
            disabled={syncState.running}
          >
            <Sync fontSize="small"
              className={isBusy ? 'spin-icon' : ''}
              style={!oauthStatus.authenticated ? { color: '#999' } : undefined}
            />
          </button>
        </div>
      </div>
    </nav>
  );
}
