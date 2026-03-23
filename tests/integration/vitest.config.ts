import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: true,
    include: ['stripe-webhooks/**/*.test.ts'],
  },
});
