import '@testing-library/jest-dom';

// Mock IntersectionObserver
class MockIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
window.IntersectionObserver = MockIntersectionObserver as any;

// Mock Cast SDK
(window as any).__onGCastApiAvailable = undefined;
(window as any).chrome = undefined;
(window as any).cast = undefined;
