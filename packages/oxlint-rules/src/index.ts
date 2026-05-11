import { definePlugin } from '@oxlint/plugins';
import { noTextLocators } from './rules/no-text-locators.ts';

export default definePlugin({
  meta: { name: '@filone/oxlint-rules' },
  rules: {
    'no-text-locators': noTextLocators,
  },
});
