import { defineRule } from '@oxlint/plugins';

const BANNED_METHOD_NAMES: ReadonlySet<string> = new Set([
  'getByRole',
  'getByText',
  'getByLabel',
  'getByPlaceholder',
  'getByTitle',
  'getByAltText',
]);

export const noTextLocators = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow Playwright text/role-based locators in E2E tests; prefer #id selectors.',
    },
    schema: [],
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const { callee } = node;
        if (callee.type !== 'MemberExpression') return;
        if (callee.computed) return;
        if (callee.property.type !== 'Identifier') return;
        const name = callee.property.name;
        if (!BANNED_METHOD_NAMES.has(name)) return;
        context.report({
          node,
          message:
            `Avoid \`${name}\` in E2E tests — it's brittle to copy/i18n changes. ` +
            `Add an \`id\` attribute to the target element and use \`page.locator('#some-id')\` instead. ` +
            `If adding an id isn't feasible, use \`getByTestId\`.`,
        });
      },
    };
  },
});
