import { defineConfig } from 'vitest/config';

// Browser tests. They need a prior `npm run build` and a Playwright install, so they are not part of `npm test`.
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
