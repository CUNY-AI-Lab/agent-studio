import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

class TestResizeObserver implements ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}

  observe(_target: Element, _options?: ResizeObserverOptions) {}

  unobserve(_target: Element) {}

  disconnect() {}
}

if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = TestResizeObserver;
}

// Auto-cleanup between tests. Testing Library only registers this automatically
// when Vitest globals are enabled; we run without globals, so wire it manually.
afterEach(() => {
  cleanup();
});
