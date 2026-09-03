import {
  ArrowRightIcon,
  BookOpenIcon,
  LifebuoyIcon,
  UserPlusIcon,
} from '@phosphor-icons/react/dist/ssr';

import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Heading } from '../components/Heading/Heading';
import type { IconProps } from '../components/Icon';
import { IconBox } from '../components/IconBox';
import { Link } from '../components/Link';
import { PageLayout } from '../components/PageLayout';

type TaskProps = {
  title: string;
  description: string;
  children: React.ReactNode;
};

/**
 * One task, as a column in the full-width divided row below — same
 * hairline-divider pattern as `UsageCard`'s stat columns, so the two reads as
 * one unit rather than two unrelated actions. Sits directly on the page
 * background rather than in a `Card`: with an illustration above it, a
 * bordered box around each half doubled up the framing.
 *
 * The action sits on the same row as the heading, at the illustration's
 * trailing edge, so the button reads as answering the heading rather than
 * trailing behind the description as an afterthought.
 *
 * The illustration slot is a placeholder (a flagged gap, not a real asset)
 * until product has one to drop in.
 */
function Task({ title, description, children }: TaskProps) {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex h-56 w-full items-center justify-center rounded-lg border border-dashed border-zinc-200 bg-zinc-50">
        <span className="text-xs text-zinc-400">Illustration placeholder</span>
      </div>
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
        <Heading tag="h2" size="md" description={description}>
          {title}
        </Heading>
        {children}
      </div>
    </div>
  );
}

type ExploreItemProps = {
  title: string;
  description: string;
  href: string;
  action: string;
  icon: IconProps['component'];
};

/** Mirrors `Link`'s own external check, so this file's icon override agrees with it. */
function isExternal(href: string): boolean {
  return !href.startsWith('/') && !href.startsWith('#') && !href.startsWith('mailto:');
}

/**
 * One optional next step. Now a `Card` like the rest of the console's grids
 * (see `DashboardPage`'s stat cards), matched to the two tasks above being
 * promoted to full width and off the card treatment they used to share.
 *
 * The link carries `mt-auto` so it sits on the same baseline across a row
 * even when one description wraps to an extra line: cards in a CSS grid row
 * already stretch to equal height, `mt-auto` is what uses that height.
 */
function ExploreItem({ title, description, href, action, icon }: ExploreItemProps) {
  return (
    <Card className="flex flex-col gap-3">
      <IconBox icon={icon} color="grey" className="self-start" />
      <Heading tag="h3" size="sm" description={description}>
        {title}
      </Heading>
      {/* No icon override on an external href: Link supplies ArrowUpRightIcon
          on its own for those, and passing ArrowRightIcon here as well would
          double up on the docs link, the only external one in this row. */}
      <Link
        href={href}
        icon={isExternal(href) ? undefined : ArrowRightIcon}
        className="mt-auto text-sm"
      >
        {action}
      </Link>
    </Card>
  );
}

type OnboardingPageProps = {
  /** Whether the account holds a bucket yet. */
  hasBucket?: boolean;
  /** Whether the account holds a key yet. */
  hasKey?: boolean;
};

/**
 * Where a new organization lands: the two things every account needs before
 * it can store anything, side by side because neither depends on the other.
 *
 * Deliberately not a form embedded in this page. Bucket creation carries
 * choices that cannot be undone after creation (object lock, retention), so
 * this links to the real page rather than a reduced version that would
 * default those silently.
 *
 * How to connect an S3 client lives in the docs, not here: it is reference
 * material a developer returns to, not a task that gets checked off, and the
 * console's own upload flow already covers the people who never leave it.
 */
export function OnboardingPage({ hasBucket, hasKey }: OnboardingPageProps) {
  return (
    <PageLayout
      title="Get started"
      description="Create a bucket to start storing objects or add an API key to connect an S3 client."
    >
      <div className="mt-10 flex flex-col divide-y divide-zinc-200 sm:flex-row sm:divide-x sm:divide-y-0">
        <div className="pb-8 sm:flex-1 sm:pr-8 sm:pb-0">
          <Task title="Create a bucket" description="Buckets hold your objects.">
            <Button variant="primary" size="sm" href="/buckets/create">
              {hasBucket ? 'Create another bucket' : 'Create bucket'}
            </Button>
          </Task>
        </div>
        <div className="pt-8 sm:flex-1 sm:pt-0 sm:pl-8">
          <Task
            title="Create an API key"
            description="An API key is needed to connect an S3 client."
          >
            <Button variant="primary" size="sm" href="/api-keys/create">
              {hasKey ? 'Create another key' : 'Create API key'}
            </Button>
          </Task>
        </div>
      </div>

      <div className="mt-10 border-t border-zinc-200 pt-8">
        <h2 className="mb-6 text-base font-medium text-zinc-900">Explore more</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <ExploreItem
            icon={UserPlusIcon}
            title="Invite your team"
            description="Give teammates a seat in this organization."
            href="/members?tab=invitations"
            action="Invite people"
          />
          <ExploreItem
            icon={BookOpenIcon}
            title="Read the docs"
            description="Guides and API reference for using Fil One."
            href="https://docs.fil.one"
            action="Explore the documentation"
          />
          <ExploreItem
            icon={LifebuoyIcon}
            title="Talk to us"
            description="Questions about setup, limits, or anything else."
            href="/support"
            action="Contact support"
          />
        </div>
      </div>
    </PageLayout>
  );
}
