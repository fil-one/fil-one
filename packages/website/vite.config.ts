import { defineConfig, loadEnv, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '');
  const proxyTarget = env.DEV_PROXY_TARGET; // e.g. https://staging.fil.one
  // A locally trusted cert from `mkcert localhost` (run in .cert/) replaces the
  // self-signed one, which browsers warn about.
  const certDir = path.join(__dirname, '.cert');
  const trustedCert = fs.existsSync(path.join(certDir, 'localhost.pem'))
    ? {
        cert: fs.readFileSync(path.join(certDir, 'localhost.pem')),
        key: fs.readFileSync(path.join(certDir, 'localhost-key.pem')),
      }
    : undefined;

  // sentryVitePlugin's Plugin type is pinned to a different vite version than
  // the one resolved here, so cast through unknown to satisfy PluginOption.
  const plugins: PluginOption[] = [
    react(),
    tailwindcss(),
    ...(trustedCert ? [] : [basicSsl()]),
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
      ...(trustedCert && { https: trustedCert }),
      ...(proxyTarget && {
        proxy: {
          // Anchored, so console routes such as /api-keys stay local.
          '^/api/': {
            target: proxyTarget,
            changeOrigin: true,
            headers: { 'X-Dev-Origin': 'https://localhost:5173' },
          },
          // Exact matches, so console routes such as /login-error stay local.
          '^/login(?:$|\\?)': {
            target: proxyTarget,
            changeOrigin: true,
            headers: { 'X-Dev-Origin': 'https://localhost:5173' },
          },
          '^/logout(?:$|\\?)': {
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
      ],
    },
  };
});
