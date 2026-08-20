import type { ErrorComponentProps } from '@tanstack/react-router';
import { clsx } from 'clsx';

import { Card } from './Card.js';
import { Heading } from './Heading/Heading.js';

type RecoveryLayoutProps = {
  title: string;
  description: string;
  /**
   * True when the boundary renders outside AppShell and has to supply the page
   * chrome itself. Router errors are caught inside the route that threw, so they
   * render in AppShell's <main>; an unmatched URL is caught at the root route and
   * renders on a bare page.
   */
  standalone?: boolean;
  children?: React.ReactNode;
};

function RecoveryLayout({ title, description, standalone, children }: RecoveryLayoutProps) {
  return (
    <div
      className={clsx(
        'flex items-center justify-center px-5 py-12',
        standalone && 'min-h-screen bg-zinc-50',
      )}
    >
      <Card className="w-full max-w-lg">
        {standalone && (
          <a href="/dashboard" className="mb-6 inline-block">
            <img src="/fil-one-logo.svg" alt="Fil One" className="h-7 w-auto" />
          </a>
        )}
        <Heading tag="h1" size="xl" description={description}>
          {title}
        </Heading>
        <div className="mt-6 flex flex-wrap gap-3">
          <button
            type="button"
            className="button button--primary"
            onClick={() => window.location.reload()}
          >
            Reload page
          </button>
          {/* Plain anchor, not Link: a full document load is the reliable way out of a crashed route. */}
          <a className="button button--ghost" href="/dashboard">
            Back to dashboard
          </a>
        </div>
        {children}
      </Card>
    </div>
  );
}

export function RouteErrorPage({ error }: ErrorComponentProps) {
  return (
    <RecoveryLayout
      title="Something went wrong"
      description="We couldn't finish loading this page. Reload it or return to the dashboard."
    >
      {import.meta.env.DEV && (
        <details className="mt-6 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-600">
          <summary className="cursor-pointer font-medium text-zinc-700">Technical details</summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap" tabIndex={0}>
            {error instanceof Error ? error.message : 'Unknown error'}
          </pre>
        </details>
      )}
    </RecoveryLayout>
  );
}

export function RouteNotFoundPage() {
  return (
    <RecoveryLayout
      standalone
      title="Page not found"
      description="The page may have moved, or the address may be incomplete."
    />
  );
}
