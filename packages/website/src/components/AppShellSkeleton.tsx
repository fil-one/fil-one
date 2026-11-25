import { Skeleton } from './Skeleton.js';

/** Placeholder nav rows per group, matching the entries every role sees in each. */
const NAV_GROUP_ROWS = [3, 2] as const;

/** One row shaped like a sidebar link: a 16px icon and a label on a 32px row. */
function NavRowSkeleton({ width }: { width: string }) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2">
      <Skeleton className="size-4 shrink-0" />
      <Skeleton className={`h-3 ${width}`} />
    </div>
  );
}

/**
 * The console frame while the app layout waits on `/me` for the first time:
 * the sidebar, the inset content window and the mobile top bar, with
 * placeholders where the organization, navigation, user and page heading go.
 *
 * It copies `AppShell`'s layout classes rather than rendering `AppShell`,
 * because the real shell and its sidebar read `/me`, usage and billing, and
 * those requests must not start before the layout has decided whether to send
 * the caller to sign in or verify their email first. Nothing here is
 * interactive, so there is nothing to reach before the real shell replaces it.
 */
export function AppShellSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading"
      data-testid="app-shell-loading"
      className="flex h-screen flex-col overflow-hidden bg-zinc-50"
    >
      <div className="flex flex-1 overflow-hidden bg-white">
        <div className="hidden w-60 flex-shrink-0 flex-col lg:flex">
          {/* Organization switcher */}
          <div className="flex items-center gap-2 px-4 pt-3.5 pb-2.5">
            <Skeleton className="size-6 shrink-0" />
            <Skeleton className="h-3 w-28" />
          </div>
          <div className="flex flex-col p-2">
            {NAV_GROUP_ROWS.map((rows, group) => (
              <div key={group} className={group > 0 ? 'mt-4' : ''}>
                {group > 0 && <Skeleton className="mx-3 mb-2 h-2.5 w-20" />}
                <div className="flex flex-col gap-0.5">
                  {Array.from({ length: rows }, (_, i) => (
                    <NavRowSkeleton key={i} width={i % 2 === 0 ? 'w-24' : 'w-16'} />
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="flex-1" />
          {/* User menu */}
          <div className="flex items-center gap-2.5 px-4 pt-2 pb-3.5">
            <Skeleton className="size-5 shrink-0 rounded-full" />
            <Skeleton className="h-3 w-32" />
          </div>
        </div>

        <div className="flex flex-1 flex-col overflow-hidden lg:px-2 lg:pt-2">
          <div className="flex-1 overflow-hidden bg-zinc-50 lg:rounded-xl lg:border lg:border-zinc-200 lg:shadow-xs">
            {/* Mobile top bar: user avatar at the left, menu button at the right. */}
            <div className="flex h-14 items-center justify-between border-b border-zinc-200 bg-white px-3 lg:hidden">
              <div className="flex size-11 items-center justify-center">
                <Skeleton className="size-7 rounded-full" />
              </div>
              <div className="-mr-1 flex size-11 items-center justify-center">
                <Skeleton className="size-5" />
              </div>
            </div>
            {/* Page heading, in `PageLayout`'s position */}
            <div className="px-5 pt-6 sm:px-8 lg:px-10 lg:pt-10">
              <Skeleton className="h-7 w-40" />
              <Skeleton className="mt-2 h-4 w-64 max-w-full" />
            </div>
          </div>
          {/* Utility bar under the content window */}
          <div className="hidden h-12 flex-shrink-0 lg:block" />
        </div>
      </div>
    </div>
  );
}
