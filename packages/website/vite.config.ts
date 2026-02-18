import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Resolve @hyperspace/shared directly from source at dev time —
      // no separate build step required.
      '@hyperspace/shared': path.resolve(__dirname, '../shared/src/index.ts'),
    },
  },
});
