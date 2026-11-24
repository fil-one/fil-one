import './sentry.js';
import './zod-config.js';
import './plausible.js';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { router } from './router.js';
import { queryClient } from './lib/query-client.js';
import { seedActiveOrgFromLastUsed } from './lib/active-org.js';

// Before the router's first `/me`, which reads the stash for its org header.
seedActiveOrgFromLastUsed();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element not found');

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
