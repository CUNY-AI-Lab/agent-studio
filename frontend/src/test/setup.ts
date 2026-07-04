import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Auto-cleanup between tests. Testing Library only registers this automatically
// when Vitest globals are enabled; we run without globals, so wire it manually.
afterEach(() => {
  cleanup();
});
