import { definePlugin } from '@oxlint/plugins';
import { noJsDynamicImport } from './rules/no-js-dynamic-import.ts';
import { noTextLocators } from './rules/no-text-locators.ts';

export default definePlugin({
  meta: { name: '@filone/oxlint-rules' },
  rules: {
    'no-js-dynamic-import': noJsDynamicImport,
    'no-text-locators': noTextLocators,
  },
});
