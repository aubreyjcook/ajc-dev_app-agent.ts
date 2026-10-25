import { defineConfig } from 'vitest/config';

// Minimal Vitest configuration. Tests live in `tests/` and import from `src/`.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
