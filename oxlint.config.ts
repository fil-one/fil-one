import { defineConfig } from 'oxlint';

export default defineConfig({
  plugins: ['typescript'],
  rules: {
    'typescript/no-floating-promises': 'error',
  },
  options: {
    typeAware: true,
  },
  ignorePatterns: ['.sst', 'packages/ui', '**/dist', '**/sst-env.d.ts'],
});
