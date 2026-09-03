import { ArrowRightIcon } from '@phosphor-icons/react/dist/ssr';

import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Heading } from '../components/Heading/Heading';
import { Link } from '../components/Link';
import { PageLayout } from '../components/PageLayout';

type TaskProps = { title: string; description: string; children: React.ReactNode };

/**
 * One task, as a column inside the shared divided card below — same
 * hairline-divider pattern as `UsageCard`'s stat columns, so a set of related
 * items reads as one card rather than several.
 */
function Task({ title, description, children }: TaskProps) {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <Heading tag="h2" size="md" description={description}>
        {title}
      </Heading>
      {children}
    </div>
  );
}

type ExploreItemProps = { title: string; description: string; href: string; action: string };

/** Mirrors `Link`'s own external check, so this file's icon override agrees with it. */
function isExternal(href: string): boolean {
  return !href.startsWith('/') && !href.startsWith('#') && !href.startsWith('mailto:');
}

/**
 * One optional next step, set directly on the page background rather than in
 * a card. Unlike the two tasks above, none of these completes, and giving
 * them the same bordered-box treatment made them read as more of the same
 * checklist. Plain text with more room around it reads as what it is:
 * suggestions, not steps.
 */
function ExploreItem({ title, description, href, action }: ExploreItemProps) {
  return (
    <div>
      <Heading tag="h3" size="sm" description={description}>
        {title}
      </Heading>
      {/* No icon override on an external href: Link supplies ArrowUpRightIcon
          on its own for those, and passing ArrowRightIcon here as well would
          double up on the docs link, the only external one in this row. */}
      <Link
        href={href}
        icon={isExternal(href) ? undefined : ArrowRightIcon}
        className="mt-3 text-sm"
      >
        {action}
      </Link>
    </div>
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
      title="Let&rsquo;s store something"
      description="Two things to set up before you upload your first object."
    >
      <Card>
        <div className="flex flex-col divide-y divide-zinc-200 sm:flex-row sm:divide-x sm:divide-y-0">
          <div className="pb-6 sm:pr-6 sm:pb-0">
            <Task title="Create a bucket" description="Buckets hold your objects.">
              <Button variant="primary" size="sm" href="/buckets/create">
                {hasBucket ? 'Create another bucket' : 'Create bucket'}
              </Button>
            </Task>
          </div>
          <div className="pt-6 sm:pt-0 sm:pl-6">
            <Task
              title="Create an API key"
              description="This is how an S3 client authenticates as you."
            >
              <Button variant="primary" size="sm" href="/api-keys/create">
                {hasKey ? 'Create another key' : 'Create an API key'}
              </Button>
            </Task>
          </div>
        </div>
      </Card>

      <div className="mt-10 border-t border-zinc-200 pt-8">
        <h2 className="mb-6 text-base font-medium text-zinc-900">Explore more</h2>
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
          <ExploreItem
            title="Invite your team"
            description="Give teammates a seat in this organization."
            href="/members"
            action="Invite people"
          />
          <ExploreItem
            title="Read the API docs"
            description="Endpoints, regions, and how to connect any S3 client."
            href="https://docs.fil.one"
            action="View docs"
          />
          <ExploreItem
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
