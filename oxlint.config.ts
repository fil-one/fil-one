import { defineConfig } from 'oxlint';

export default defineConfig({
  plugins: ['typescript'],
  rules: {
    'typescript/no-explicit-any': 'error',
    'typescript/no-floating-promises': 'error',
  },
  options: {
    typeAware: true,
    typeCheck: true, 
  },
  ignorePatterns: ['.sst', 'packages/ui', '**/dist', '**/sst-env.d.ts', 'sst.config.ts', 'bin/'],
});
