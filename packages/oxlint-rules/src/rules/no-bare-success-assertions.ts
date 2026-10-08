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
            'Assert on the whole result with `toMatchObject`. For a rejection, match the specific issue: ' +
            "`expect(result).toMatchObject({ success: false, error: { issues: [{ code: 'invalid_type', path: ['name'] }] } })`. " +
            'For a success, write `expect(result).toMatchObject({ success: true })`; a failure then prints the error. ' +
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
function isSuccessProperty(argument: ESTree.Argument): boolean {
  const expression = argument.type === 'ChainExpression' ? argument.expression : argument;
  return (
    expression.type === 'MemberExpression' &&
    !expression.computed &&
    expression.property.type === 'Identifier' &&
    expression.property.name === 'success'
  );
}
