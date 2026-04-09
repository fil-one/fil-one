import { defineConfig } from 'oxlint';

export default defineConfig({
  plugins: ['typescript'],
  rules: {
    'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }],
    'max-lines-per-function': [
      'error',
      { max: 100, skipBlankLines: true, skipComments: true, IIFEs: false },
    ],
    'typescript/no-explicit-any': 'error',
    'typescript/no-floating-promises': 'error',
  },
  options: {
    typeAware: true,
    typeCheck: true,
  },
  ignorePatterns: [
    '.sst',
    'infra',
    'packages/ui',
    '**/dist',
    '**/generated',
    '**/sst-env.d.ts',
    'test-results',
    'playwright-report',
    'blob-report',
    'playwright/.cache',
    'playwright/.auth',
  ],
  overrides: [
    {
      // sst.config.ts must use a triple-slash reference for SST's generated types
      files: ['sst.config.ts'],
      rules: {
        'max-lines': 'off',
        'max-lines-per-function': 'off',
        'typescript/triple-slash-reference': 'off',
      },
    },
    {
      files: ['**/*.test.ts', '**/*.test.tsx'],
      rules: {
        'max-lines': 'off',
        'max-lines-per-function': 'off',
      },
    },
    {
      files: ['packages/website/**/*.ts', 'packages/website/**/*.tsx'],
      rules: {
        'max-lines-per-function': [
          'error',
          { max: 200, skipBlankLines: true, skipComments: true, IIFEs: false },
        ],
      },
    },
  ],
});
