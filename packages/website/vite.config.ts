import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiSrc = path.resolve(__dirname, '../ui/src');

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '');
  const proxyTarget = env.DEV_PROXY_TARGET; // e.g. https://staging.fil.one

  return {
    plugins: [react(), tailwindcss(), basicSsl()],
    server: {
      ...(proxyTarget && {
        proxy: {
          '/api': {
            target: proxyTarget,
            changeOrigin: true,
            headers: { 'X-Dev-Origin': 'https://localhost:5173' },
          },
        },
      }),
    },
    resolve: {
      alias: [
        // @filone/shared — resolve from source at dev time
        {
          find: '@filone/shared',
          replacement: path.resolve(__dirname, '../shared/src/index.ts'),
        },
        // @hyperspace/ui — specific non-component sub-paths first
        { find: '@hyperspace/ui/utils', replacement: `${uiSrc}/utils/index.ts` },
        { find: '@hyperspace/ui/styles', replacement: `${uiSrc}/styles/globals.css` },
        {
          find: '@hyperspace/ui/constants/tailwindConstants',
          replacement: `${uiSrc}/constants/tailwindConstants.ts`,
        },
        { find: '@hyperspace/ui/config/ui-config', replacement: `${uiSrc}/config/ui-config.ts` },
        // @hyperspace/ui — general component sub-path fallback
        // e.g. @hyperspace/ui/Button → src/components/Button.tsx
        { find: /^@hyperspace\/ui\/(.+)/, replacement: `${uiSrc}/components/$1` },
      ],
    },
  };
});
