import { Sync, NoteAdd, CreateNewFolder, AutoAwesome, FileUpload, FileDownload } from '@mui/icons-material';
import { useAppContext } from '../../context/AppContext';

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

  const sections = ['feeds', 'playlists', 'subscriptions'] as const;

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
            title="Sync"
            onClick={onSync}
          >
            <Sync fontSize="small" className={syncState.running ? 'spin-icon' : ''} />
          </button>
        </div>
      </div>
    </nav>
  );
}
