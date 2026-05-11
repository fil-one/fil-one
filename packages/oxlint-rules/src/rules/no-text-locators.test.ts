import { describe, it } from 'vitest';
import { RuleTester } from 'oxlint/plugins-dev';
import { noTextLocators } from './no-text-locators.ts';

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: 'ts' } },
});

const banned = [
  'getByRole',
  'getByText',
  'getByLabel',
  'getByPlaceholder',
  'getByTitle',
  'getByAltText',
];

tester.run('no-text-locators', noTextLocators, {
  valid: [
    "page.getByTestId('user-menu').click();",
    "page.locator('#user-menu').click();",
    "await expect(page.locator('#dashboard-heading')).toBeVisible();",
    "obj.someUnrelatedMethod('getByRole');",
    "const fn = page.getByRole; fn('button');",
  ],
  invalid: [
    ...banned.map((name) => ({
      code: `page.${name}('arg').click();`,
      errors: 1,
    })),
    {
      code: "page.locator('#wrap').getByRole('button', { name: 'Save' }).click();",
      errors: 1,
    },
    {
      code: "frame.getByRole('button').click(); page.getByText('hi');",
      errors: 2,
    },
  ],
});
