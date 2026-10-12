import { defineRule, type ESTree } from '@oxlint/plugins';

export const noBareSuccessAssertions = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow expect() on a bare `.success` property; assert on the whole result with toMatchObject.',
    },
    schema: [],
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (!isExpectCall(node.callee)) return;
        const [subject] = node.arguments;
        if (subject === undefined || !isSuccessProperty(subject)) return;
        context.report({
          node: subject,
          message:
            'Assert on the whole result. For a rejected zod parse, list the expected issues: ' +
            "`expect(result).toMatchZodValidationError({ code: 'invalid_type', path: ['name'] })`. " +
            'The matcher is set up in packages/shared/src/testing/zod-matchers.ts; ' +
            'another package adds that file to its vitest `setupFiles`. ' +
            'For a successful parse, write `expect(result).toMatchObject({ success: true })`; a failure then prints the error. ' +
            'A failed check on `.success` alone prints only "expected true to be false", ' +
            'and the test can pass for a different reason than the one it names.',
        });
      },
    };
  },
});

// Matches `expect(...)` and `expect.soft(...)`.
function isExpectCall(callee: ESTree.Expression): boolean {
  if (callee.type === 'Identifier') return callee.name === 'expect';
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'expect' &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'soft'
  );
}

// Matches `x.success` and `x?.success`.
// The check is deliberately simple: any `success` property counts, whatever
// produced `x`. If it starts reporting false positives, narrow it, e.g. to
// results of `safeParse()` calls.
function isSuccessProperty(argument: ESTree.Argument): boolean {
  const expression = argument.type === 'ChainExpression' ? argument.expression : argument;
  return (
    expression.type === 'MemberExpression' &&
    !expression.computed &&
    expression.property.type === 'Identifier' &&
    expression.property.name === 'success'
  );
}
