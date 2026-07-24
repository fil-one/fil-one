import { defineConfig } from '@hey-api/openapi-ts';

export default defineConfig({
  input: '../../docs/service-orchestrator-integration/management-openapi.yaml',
  output: {
    path: './src/generated',
    importFileExtension: '.ts',
    postProcess: ['oxfmt'],
  },
});
