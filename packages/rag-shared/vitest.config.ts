import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The Lance store tests run against a real S3-compatible server over HTTP
    // and write real datasets, so they are slower than the default 5s allows.
    testTimeout: 30_000,
  },
});
