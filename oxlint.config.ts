import { defineConfig } from 'oxlint';

export default defineConfig({
  plugins: ['typescript'],
  jsPlugins: ['oxlint-plugin-complexity'],
  rules: {
    'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }],
    'max-lines-per-function': [
      'error',
      { max: 100, skipBlankLines: true, skipComments: true, IIFEs: false },
    ],
    'complexity/complexity': ['error', { cyclomatic: 20, cognitive: 15 }],
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
      files: ['sst.config.ts'],
      rules: {
        'max-lines': 'off',
        'max-lines-per-function': 'off',
        'complexity/complexity': 'off',
        // sst.config.ts must use a triple-slash reference for SST's generated types
        'typescript/triple-slash-reference': 'off',
      },
    },
    {
      files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'],
      rules: {
        'max-lines': 'off',
        'max-lines-per-function': 'off',
        'complexity/complexity': 'off',
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
