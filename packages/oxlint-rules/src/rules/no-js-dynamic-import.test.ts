import { describe, it } from 'vitest';
import { RuleTester } from 'oxlint/plugins-dev';
import { noJsDynamicImport } from './no-js-dynamic-import.ts';

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: 'ts' } },
});

tester.run('no-js-dynamic-import', noJsDynamicImport, {
  valid: [
    "const mod = import('./x.ts');",
    "const mod = import('lodash');",
    'async function load(path: string) { return import(path); }',
    "import { x } from './x.ts';",
    'const mod = import(`./x.ts`);',
    'const mod = import(`./handlers/${handler}.ts`);',
  ],
  invalid: [
    {
      code: "const mod = import('./x.js');",
      errors: 1,
    },
    {
      code: "async function load() { const mod = await import('../y.js'); return mod; }",
      errors: 1,
    },
    {
      code: "const mod = import('@filone/shared/src/z.js');",
      errors: 1,
    },
    {
      code: "const a = import('./a.js'); const b = import('./b.js');",
      errors: 2,
    },
    {
      code: 'const mod = import(`./x.js`);',
      errors: 1,
    },
    {
      code: 'const mod = import(`./handlers/${handler}.js`);',
      errors: 1,
    },
  ],
});
