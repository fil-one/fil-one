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
    'expect(schema.safeParse(input)).toMatchObject({ success: true });',
    "expect(result).toMatchZodValidationError({ code: 'invalid_type', path: ['name'] });",
    'expect(result).toMatchObject({ success: false, error: { issues: [] } });',
    'expect(result).toStrictEqual({ success: true, data: { name: "a" } });',
    'expect(result.data).toEqual({ name: "a" });',
    'expect(result.successCount).toBe(2);',
    'if (!result.success) throw result.error;',
    'other(result.success);',
    'assertLike(result).toMatchObject({ success: false });',
    'const success = calls.find(isIdle); expect(success).toBeDefined();',
    'function check(success: boolean) { expect(success).toBe(true); }',
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
    {
      code: "expect(result['success']).toBe(true);",
      errors: 1,
    },
    {
      code: 'expect(result[`success`]).toBe(true);',
      errors: 1,
    },
    {
      code: 'expect(!result.success).toBe(true);',
      errors: 1,
    },
    {
      code: 'expect(result.success === false).toBe(true);',
      errors: 1,
    },
    {
      code: 'expect(describeOutcome(result.success)).toBe("ok");',
      errors: 1,
    },
    {
      code: 'const { success } = schema.safeParse(input); expect(success).toBe(false);',
      errors: 1,
    },
    {
      code: 'const { success = false } = result; expect(Boolean(success)).toBe(false);',
      errors: 1,
    },
    {
      code: 'expect(schema.safeParse(input)).toMatchObject({ success: false });',
      errors: 1,
    },
    {
      code: "expect(result).toEqual({ 'success': false });",
      errors: 1,
    },
    {
      code: 'expect(result).toStrictEqual({ success: false });',
      errors: 1,
    },
    {
      code: 'expect(result).not.toMatchObject({ success: false });',
      errors: 1,
    },
  ],
});
