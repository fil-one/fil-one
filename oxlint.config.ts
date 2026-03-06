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
  ignorePatterns: ['.sst', 'packages/ui', '**/dist', '**/sst-env.d.ts', 'bin/'],
  overrides: [
    {
      // sst.config.ts must use a triple-slash reference for SST's generated types
      files: ['sst.config.ts'],
      rules: {
        'typescript/triple-slash-reference': 'off',
      },
    },
  ],
});
