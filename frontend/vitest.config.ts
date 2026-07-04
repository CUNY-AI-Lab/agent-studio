import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Test-only config, intentionally separate from vite.config.ts so the
// production build (manual chunks, modulePreload tuning, dev proxy) stays
// untouched. We only need the React plugin to compile JSX/TSX for tests.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
