import { defineConfig } from '@hey-api/openapi-ts';

export default defineConfig({
  input: './aurora-portal.swagger.json',
  output: {
    path: './src/generated',
    importFileExtension: '.ts',
    postProcess: ['oxfmt'],
  },
});
