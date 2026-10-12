import { describe, it } from 'vitest';
import { RuleTester } from 'oxlint/plugins-dev';
import { noBareSuccessAssertions } from './no-bare-success-assertions.ts';

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: 'ts' } },
});

tester.run('no-bare-success-assertions', noBareSuccessAssertions, {
  valid: [
    'expect(schema.safeParse(input)).toMatchObject({ success: false });',
    'expect(result).toStrictEqual({ success: true, data: { name: "a" } });',
    'expect(result.data).toEqual({ name: "a" });',
    'if (!result.success) throw result.error;',
    'expect(describeOutcome(result.success)).toBe("ok");',
    // A computed `['success']` key is out of scope; nobody writes it that way.
    "expect(result['success']).toBe(true);",
    'other(result.success);',
  ],
  invalid: [
    {
      code: 'expect(result.success).toBe(true);',
      errors: 1,
    },
    {
      code: 'expect(schema.safeParse(input).success).toBe(false);',
      errors: 1,
    },
    {
      code: 'expect(result?.success).toBe(false);',
      errors: 1,
    },
    {
      code: "expect(result.success, 'parses a valid body').toBe(true);",
      errors: 1,
    },
    {
      code: 'expect.soft(result.success).toBeTruthy();',
      errors: 1,
    },
    {
      code: 'expect(\n  schema.safeParse({ code: "123456" }).success,\n).toBe(false);',
      errors: 1,
    },
    {
      code: 'expect(a.success).toBe(true); expect(b.success).toBe(false);',
      errors: 2,
    },
  ],
});
