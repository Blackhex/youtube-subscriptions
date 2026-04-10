import { vi } from 'vitest';
import '@testing-library/jest-dom';

// Mock window.matchMedia for useTheme hook
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock @mui/icons-material to avoid heavy barrel import that causes test hangs
vi.mock('@mui/icons-material', () => {
  const icon = () => null;
  return {
    PlaylistAdd: icon,
    PlaylistAddCheck: icon,
    Close: icon,
    DragIndicator: icon,
    Delete: icon,
    OpenInNew: icon,
    Cast: icon,
    Description: icon,
    Edit: icon,
    NoteAdd: icon,
    Sync: icon,
    CreateNewFolder: icon,
    AutoAwesome: icon,
    FileUpload: icon,
    FileDownload: icon,
    Add: icon,
    ExpandMore: icon,
    ExpandLess: icon,
    ChevronRight: icon,
    FolderOpen: icon,
    Folder: icon,
    DarkMode: icon,
    LightMode: icon,
    CheckBox: icon,
    CheckBoxOutlineBlank: icon,
    Visibility: icon,
  };
});

// Mock IntersectionObserver
class MockIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
window.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;

// Mock Cast SDK
window.__onGCastApiAvailable = undefined;
window.chrome = undefined;
window.cast = undefined;
