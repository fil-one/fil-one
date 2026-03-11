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
  ignorePatterns: ['.sst', 'infra', 'packages/ui', '**/dist', '**/generated', '**/sst-env.d.ts'],
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
