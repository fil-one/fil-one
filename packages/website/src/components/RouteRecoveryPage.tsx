import type { ErrorComponentProps } from '@tanstack/react-router';

import { Card } from './Card.js';
import { Heading } from './Heading/Heading.js';
import { AuthCard } from './AuthCard.js';

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
  /** Actions (and any extras) rendered below the description. */
  children: React.ReactNode;
};

function RecoveryLayout({ title, description, standalone, children }: RecoveryLayoutProps) {
  const content = (
    <>
      <Heading tag="h1" size="lg" balance className="font-normal tracking-tight">
        {title}
      </Heading>
      <p className="mt-2 text-sm text-(--color-paragraph-text)">{description}</p>
      {children}
    </>
  );

  // Standalone (404, root crash): the shared auth card supplies the full-screen
  // ground and the Fil One lockup, matching verify-email and the Auth0 screens.
  if (standalone) return <AuthCard>{content}</AuthCard>;

  // Inside AppShell's <main>: the shell supplies the page chrome, so no
  // full-screen ground here. The lockup still rides on the card so it reads as
  // a deliberate surface, matching the standalone recovery and auth cards.
  return (
    <div className="flex items-center justify-center px-5 py-12">
      <Card padding="none" className="w-full max-w-[420px] p-8">
        <img src="/fil-one-logo.svg" alt="Fil One" className="mb-8 h-5 w-auto" />
        {content}
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
      <button
        type="button"
        className="button button--primary button--lg mt-6 w-full justify-center py-3.5"
        onClick={() => window.location.reload()}
      >
        Reload page
      </button>
      {/* Plain anchor, not Link: a full document load is the reliable way out of a crashed route. */}
      <a
        className="button button--ghost button--lg mt-3 w-full justify-center py-3.5"
        href="/dashboard"
      >
        Back to dashboard
      </a>
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
    >
      {/* Reload is pointless on a 404, so the only action is a way back. */}
      <a
        className="button button--primary button--lg mt-6 w-full justify-center py-3.5"
        href="/dashboard"
      >
        Back to dashboard
      </a>
    </RecoveryLayout>
  );
}
