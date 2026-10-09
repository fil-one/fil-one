import { defineRule, type ESTree, type Scope, type SourceCode } from '@oxlint/plugins';

const OBJECT_MATCHERS: ReadonlySet<string> = new Set(['toMatchObject', 'toEqual', 'toStrictEqual']);

const MATCHER_SETUP =
  'The matcher is set up in packages/shared/src/testing/zod-matchers.ts; ' +
  'another package adds that file to its vitest `setupFiles`.';

const SUCCESS_REFERENCE_MESSAGE =
  'Assert on the whole result. For a rejected zod parse, list the expected issues: ' +
  "`expect(result).toMatchZodValidationError({ code: 'invalid_type', path: ['name'] })`. " +
  `${MATCHER_SETUP} ` +
  'For a successful parse, write `expect(result).toMatchObject({ success: true })`; a failure then prints the error. ' +
  'A failed check on `success` alone prints only "expected true to be false", ' +
  'and the test can pass for a different reason than the one it names.';

const FAILURE_ONLY_MESSAGE =
  'List the issues the rejection should have: ' +
  "`expect(result).toMatchZodValidationError({ code: 'invalid_type', path: ['name'] })`. " +
  `${MATCHER_SETUP} ` +
  '`{ success: false }` alone names no issue: `toMatchObject` accepts any rejection, ' +
  'and `toEqual` or `toStrictEqual` fail on every real one, which also carries an `error`.';

export const noBareSuccessAssertions = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow assertions on `success` alone; assert on the whole result and name the expected issues.',
    },
    schema: [],
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (isExpectCall(node.callee)) {
          const [subject] = node.arguments;
          if (subject === undefined) return;
          for (const reference of findSuccessReferences(subject, context.sourceCode)) {
            context.report({ node: reference, message: SUCCESS_REFERENCE_MESSAGE });
          }
          return;
        }
        const [expected] = node.arguments;
        if (isObjectMatcherCall(node.callee) && expected !== undefined && isFailureOnly(expected)) {
          context.report({ node: expected, message: FAILURE_ONLY_MESSAGE });
        }
      },
    };
  },
});

// Matches `expect(...)` and `expect.soft(...)`.
function isExpectCall(callee: ESTree.Node): boolean {
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

// Returns every `success` reference inside an expect() argument: `x.success`,
// `x?.success`, `x['success']`, and a variable destructured from a `success`
// property (`const { success } = x`, `const { success: ok } = x`), also when
// wrapped (`!x.success`, `x.success === false`, `Boolean(ok)`). Any `success`
// property counts, whatever object it belongs to. A plain variable that
// happens to be named `success` does not, since tests use the name for
// unrelated values.
function findSuccessReferences(root: ESTree.Node, sourceCode: SourceCode): ESTree.Node[] {
  const references: ESTree.Node[] = [];
  visit(root);
  return references;

  function visit(node: ESTree.Node): void {
    if (node.type === 'Identifier') {
      if (isDestructuredFromSuccess(node, sourceCode)) references.push(node);
      return;
    }
    if (node.type === 'MemberExpression') {
      if (isSuccessKey(node.property, node.computed)) references.push(node);
      visit(node.object);
      if (node.computed) visit(node.property);
      return;
    }
    if (node.type === 'Property') {
      if (node.computed) visit(node.key);
      visit(node.value);
      return;
    }
    for (const child of getChildNodes(node)) visit(child);
  }
}

// Matches a variable bound by `const { success } = x`, `const { success: ok } = x`,
// or either form with a default value.
function isDestructuredFromSuccess(identifier: ESTree.Node, sourceCode: SourceCode): boolean {
  const variable = findReference(sourceCode.getScope(identifier), identifier)?.resolved;
  if (!variable) return false;
  return variable.defs.some((definition) => {
    let binding: ESTree.Node | null = definition.name.parent;
    if (binding?.type === 'AssignmentPattern') binding = binding.parent;
    return (
      binding?.type === 'Property' &&
      binding.parent?.type === 'ObjectPattern' &&
      isSuccessKey(binding.key, binding.computed)
    );
  });
}

function findReference(scope: Scope | null, identifier: ESTree.Node) {
  for (let current = scope; current !== null; current = current.upper) {
    const reference = current.references.find((candidate) => candidate.identifier === identifier);
    if (reference) return reference;
  }
  return undefined;
}

// Matches `expect(...).toMatchObject` and `expect(...)['toMatchObject']`, also
// after `.not`, `.resolves` or `.rejects`.
function isObjectMatcherCall(callee: ESTree.Node): boolean {
  if (callee.type !== 'MemberExpression') return false;
  const matcherName = getStaticKeyName(callee.property, callee.computed);
  if (matcherName === undefined || !OBJECT_MATCHERS.has(matcherName)) return false;
  let target: ESTree.Node = callee.object;
  while (target.type === 'MemberExpression') target = target.object;
  return target.type === 'CallExpression' && isExpectCall(target.callee);
}

// Matches an object literal whose only property is `success: false`, also
// inside `as const` or `satisfies`.
function isFailureOnly(expected: ESTree.Node): boolean {
  const object = unwrapTypeScript(expected);
  if (object.type !== 'ObjectExpression' || object.properties.length !== 1) return false;
  const [property] = object.properties;
  if (property.type !== 'Property' || !isSuccessKey(property.key, property.computed)) return false;
  const value = unwrapTypeScript(property.value);
  return value.type === 'Literal' && value.value === false;
}

function isSuccessKey(key: ESTree.Node, computed: boolean): boolean {
  return getStaticKeyName(key, computed) === 'success';
}

// Returns the name a member or property key spells out: `name`, `'name'` or
// `` `name` ``. A computed `[name]` is a variable reference, so it has none.
function getStaticKeyName(key: ESTree.Node, computed: boolean): string | undefined {
  if (key.type === 'Identifier') return computed ? undefined : key.name;
  if (key.type === 'Literal') return typeof key.value === 'string' ? key.value : undefined;
  if (key.type === 'TemplateLiteral' && key.expressions.length === 0) {
    return key.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

// Strips TypeScript syntax that wraps an expression without changing its value.
function unwrapTypeScript(node: ESTree.Node): ESTree.Node {
  let current = node;
  while (
    current.type === 'TSAsExpression' ||
    current.type === 'TSSatisfiesExpression' ||
    current.type === 'TSNonNullExpression' ||
    current.type === 'TSTypeAssertion'
  ) {
    current = current.expression;
  }
  return current;
}

function getChildNodes(node: ESTree.Node): ESTree.Node[] {
  const children: ESTree.Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue;
    const candidates: unknown[] = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      if (isNode(candidate)) children.push(candidate);
    }
  }
  return children;
}

function isNode(value: unknown): value is ESTree.Node {
  return (
    typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'
  );
}
