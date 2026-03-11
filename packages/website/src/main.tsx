import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, Link } from '@tanstack/react-router';
import { setUIConfig } from '@hyperspace/ui/config/ui-config';
import { router } from './router.js';

// Configure the UI library to use TanStack Router's Link component.
// MinimalLinkProps uses `href` but TanStack Router's Link uses `to`.
// We adapt here so the UI library's BaseLink/Button components route correctly.
// UNKNOWN: Should we map `href` → `to` for TanStack Router Link, or is there a
// shared adapter already defined elsewhere in the project?
setUIConfig({
  baseDomain: window.location.hostname,
  // Cast required because TanStack Router Link uses `to` not `href`,
  // but internal links in the UI package pass href as a string path.
  // eslint-disable-next-line typescript/no-explicit-any
  Link: ({ href, children, ...rest }: any) => (
    <Link to={href} {...rest}>
      {children}
    </Link>
  ),
});

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element not found');

createRoot(rootEl).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
