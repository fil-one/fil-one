import { defineConfig } from '@hey-api/openapi-ts';

export default defineConfig({
  input: './aurora-portal.swagger.yaml',
  output: {
    path: './src/generated',
    importFileExtension: '.ts',
    postProcess: ['oxfmt'],
  },
});
