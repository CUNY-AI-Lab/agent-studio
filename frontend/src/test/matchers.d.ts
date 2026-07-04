// Augments Vitest's `expect` with @testing-library/jest-dom matchers
// (toBeInTheDocument, toHaveTextContent, etc.) for type-checking test files.
// The runtime registration happens in setup.ts.
import '@testing-library/jest-dom/vitest';
