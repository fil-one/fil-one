import { defineConfig, loadEnv, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiSrc = path.resolve(__dirname, '../ui/src');

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '');
  const proxyTarget = env.DEV_PROXY_TARGET; // e.g. https://staging.fil.one

  // sentryVitePlugin's Plugin type is pinned to a different vite version than
  // the one resolved here, so cast through unknown to satisfy PluginOption.
  const plugins: PluginOption[] = [
    react(),
    tailwindcss(),
    basicSsl(),
    sentryVitePlugin({
      authToken: process.env.SENTRY_AUTH_TOKEN,
      org: 'filecoin-foundation-qk',
      project: 'filone-web',
      telemetry: false,
      release: {
        // release.name is auto-detected from the git HEAD commit SHA.
        dist: process.env.SENTRY_RELEASE_DIST || undefined,
        deploy: process.env.SENTRY_DEPLOY_ENV ? { env: process.env.SENTRY_DEPLOY_ENV } : undefined,
      },
      sourcemaps: {
        // Delete source maps after they are uploaded to Sentry.
        filesToDeleteAfterUpload: ['./dist/**/*.map'],
      },
    }) as unknown as PluginOption,
  ];

  return {
    build: {
      // A separate sourcemap file will be created.
      // The corresponding sourcemap comments in the bundled files are suppressed.
      sourcemap: 'hidden',
    },
    plugins,
    server: {
      ...(proxyTarget && {
        proxy: {
          '/api': {
            target: proxyTarget,
            changeOrigin: true,
            headers: { 'X-Dev-Origin': 'https://localhost:5173' },
          },
          '/login': {
            target: proxyTarget,
            changeOrigin: true,
            headers: { 'X-Dev-Origin': 'https://localhost:5173' },
          },
          '/logout': {
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
