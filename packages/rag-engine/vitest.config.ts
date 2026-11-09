import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Lance commits go through a real HTTP S3 server; give them room.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
