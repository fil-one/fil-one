import { defineRule } from '@oxlint/plugins';

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
        if (source.type !== 'Literal') return;
        if (typeof source.value !== 'string') return;
        if (!source.value.endsWith('.js')) return;
        context.report({
          node: source,
          message:
            `Import the .ts file by name instead of '${source.value}'. ` +
            'Plain Node does not map .js specifiers to .ts sources, so a .js import() fails outside the bundle.',
        });
      },
    };
  },
});
