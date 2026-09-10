import { defineRule, type ESTree } from '@oxlint/plugins';

export const noJsDynamicImport = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow dynamic import() of a .js specifier; name the .ts file so plain Node can load the module.',
    },
    schema: [],
  },
  createOnce(context) {
    return {
      ImportExpression(node) {
        const { source } = node;
        const specifier = staticSpecifierText(source);
        if (specifier === undefined) return;
        if (!specifier.endsWith('.js')) return;
        context.report({
          node: source,
          message:
            `Import the .ts file by name instead of '${specifier}'. ` +
            'Bundlers and test runners map a .js specifier to its .ts source; plain Node does not.',
        });
      },
    };
  },
});

// Returns the specifier text when the argument is a string or template literal,
// with `${}` placeholders abbreviated so the message shows the code as written.
function staticSpecifierText(source: ESTree.Expression): string | undefined {
  if (source.type === 'Literal') {
    return typeof source.value === 'string' ? source.value : undefined;
  }
  if (source.type === 'TemplateLiteral') {
    return source.quasis
      .map((quasi, index) => quasi.value.raw + (index < source.expressions.length ? '${…}' : ''))
      .join('');
  }
  return undefined;
}
