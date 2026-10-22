import {
  ArrowRightIcon,
  BookOpenIcon,
  LifebuoyIcon,
  UserPlusIcon,
} from '@phosphor-icons/react/dist/ssr';

import { DOCS_URL } from '@filone/shared';

import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Heading } from '../components/Heading/Heading';
import type { IconProps } from '../components/Icon';
import { IconBox } from '../components/IconBox';
import { Link, type LinkProps } from '../components/Link';
import { PageLayout } from '../components/PageLayout';

type TaskProps = {
  title: string;
  description: string;
  /** Path under `public/` to the task's illustration. */
  illustration: string;
  children: React.ReactNode;
};

/**
 * One task, as a column in the full-width divided row below — same
 * hairline-divider pattern as `UsageCard`'s stat columns, so the two read as
 * one unit rather than two unrelated actions.
 *
 * The action sits on the same row as the heading, at the illustration's
 * trailing edge, so the button reads as answering the heading rather than
 * trailing behind the description.
 *
 * The illustration sits in a frame with `Card`'s border and radius, filled a
 * step darker than the page so it reads as artwork set into the page rather
 * than as one more card like the ones below. It keeps a fixed height and its
 * own aspect ratio, centred, while the column's width varies with the
 * viewport. A narrow column crops only the faded dot grid at its sides; a
 * wide one leaves blank space there, which the grid already fades into.
 *
 * The image is positioned absolutely so its width never counts toward the
 * column's: in the flow, it would hold the column open at the drawing's full
 * width rather than be cropped. `max-w-none` lifts the base styles'
 * `max-width: 100%` on images, which would shrink the drawing instead. The
 * alt text is empty because the drawing says nothing the heading does not.
 */
function Task({ title, description, illustration, children }: TaskProps) {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="relative h-56 overflow-hidden rounded-xl border border-zinc-200 bg-zinc-100">
        <img
          src={illustration}
          alt=""
          className="absolute left-1/2 h-full w-auto max-w-none -translate-x-1/2"
        />
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
  /** Omitted for an external href, where `Link` supplies its own arrow. */
  actionIcon?: LinkProps['icon'];
};

/**
 * One optional next step, as a `Card` like the rest of the console's grids.
 *
 * The link carries `mt-auto` so it sits on the same baseline across a row
 * even when one description wraps to an extra line: cards in a CSS grid row
 * already stretch to equal height, `mt-auto` is what uses that height.
 */
function ExploreItem({ title, description, href, action, icon, actionIcon }: ExploreItemProps) {
  return (
    <Card className="flex flex-col gap-3">
      <IconBox icon={icon} color="grey" className="self-start" />
      <Heading tag="h3" size="sm" description={description}>
        {title}
      </Heading>
      <Link href={href} icon={actionIcon} className="mt-auto text-sm">
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
  /**
   * Whether the caller may send invitations here. Off, the "Invite your team"
   * card is left out rather than linking to a form the server would refuse.
   */
  mayInvite?: boolean;
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
export function OnboardingPage({ hasBucket, hasKey, mayInvite }: OnboardingPageProps) {
  return (
    <PageLayout
      title="Get started"
      description="Create a bucket to start storing objects or add an API key to connect an S3 client."
    >
      <div className="mt-10 flex flex-col divide-y divide-zinc-200 sm:flex-row sm:divide-x sm:divide-y-0">
        <div className="pb-8 sm:flex-1 sm:pr-8 sm:pb-0">
          <Task
            title="Create a bucket"
            description="Buckets hold your objects."
            illustration="/illustrations/create-bucket.svg"
          >
            <Button variant="primary" size="sm" href="/buckets/create">
              {hasBucket ? 'Create another bucket' : 'Create bucket'}
            </Button>
          </Task>
        </div>
        <div className="pt-8 sm:flex-1 sm:pt-0 sm:pl-8">
          <Task
            title="Create an API key"
            description="An API key is needed to connect an S3 client."
            illustration="/illustrations/create-api-key.svg"
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
          {mayInvite && (
            <ExploreItem
              icon={UserPlusIcon}
              title="Invite your team"
              description="Give teammates a seat in this organization."
              href="/members?tab=invitations"
              action="Invite people"
              actionIcon={ArrowRightIcon}
            />
          )}
          <ExploreItem
            icon={BookOpenIcon}
            title="Read the docs"
            description="Guides and API reference for using Fil One."
            href={DOCS_URL}
            action="Explore the documentation"
          />
          <ExploreItem
            icon={LifebuoyIcon}
            title="Talk to us"
            description="Questions about setup, limits, or anything else."
            href="/support"
            action="Contact support"
            actionIcon={ArrowRightIcon}
          />
        </div>
      </div>
    </PageLayout>
  );
}
