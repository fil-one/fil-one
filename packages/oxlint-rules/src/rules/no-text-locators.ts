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
            `Add a stable identifier to the front-end element instead:\n` +
            `  • For page-unique singletons (headings, primary/submit buttons, inputs), add an ` +
            `\`id\` and use \`page.locator('#some-id')\` — e.g. the existing \`#bucket-name\` / ` +
            `\`#key-name\` inputs.\n` +
            `  • For repeated or dynamically-rendered elements and reusable components (table ` +
            `rows, nav items, status badges, toasts), add a \`data-testid\` and use ` +
            `\`page.getByTestId('...')\`. Add a \`data-*\` value attribute (e.g. ` +
            `\`data-object-key\`, \`data-status\`) to select one specific instance, e.g. ` +
            `\`page.locator('[data-object-key="..."]')\`.`,
        });
      },
    };
  },
});
