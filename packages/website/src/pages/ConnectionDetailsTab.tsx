import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowUpRightIcon } from '@phosphor-icons/react/dist/ssr';

import type { S3Region } from '@filone/shared';
import { DOCS_URL, S3_REGION, getS3Endpoint, supportsBucketManagement } from '@filone/shared';

import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
import { CodeBlock } from '../components/CodeBlock';
import { CopyButton } from '../components/CopyButton';
import { Heading } from '../components/Heading/Heading';
import { RegionSelect } from '../components/RegionSelect';
import { Tab, TabList, TabPanel, TabPanels, Tabs } from '../components/Tabs';
import { FILONE_STAGE } from '../env';
import {
  type ConnectionClient,
  type ConnectionSnippet,
  getConnectionSnippets,
} from '../lib/connection-snippets.js';

const CLIENTS: { id: ConnectionClient; label: string }[] = [
  { id: 'cli', label: 'AWS CLI' },
  { id: 'python', label: 'Python' },
  { id: 'nodejs', label: 'Node.js' },
  { id: 'go', label: 'Go' },
];

/**
 * How to reach Fil One over S3: the facts a client needs, then the same two
 * steps for each client. The region drives the endpoint and every snippet, so
 * it leads.
 */
export function ConnectionDetailsTab() {
  const [region, setRegion] = useState<S3Region>(S3_REGION);
  const endpoint = getS3Endpoint(region, FILONE_STAGE);
  const snippets = getConnectionSnippets(region, endpoint);

  return (
    <div className="mt-6 flex flex-col gap-10">
      <ConnectionFacts region={region} onRegionChange={setRegion} endpoint={endpoint} />

      <section>
        <div className="mb-3 flex items-center justify-between">
          <Heading tag="h3" size="sm">
            Connect
          </Heading>
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 transition-colors hover:text-brand-700 hover:underline"
          >
            View docs
            <ArrowUpRightIcon size={12} weight="bold" />
          </a>
        </div>
        <BucketPrerequisite region={region} />
        <Card padding="none" className="overflow-hidden">
          <Tabs>
            <TabList className="overflow-x-auto px-2 [scrollbar-width:none]">
              {CLIENTS.map((client) => (
                <Tab
                  key={client.id}
                  testId={`connection-client-${client.id}`}
                  className="shrink-0 whitespace-nowrap"
                >
                  {client.label}
                </Tab>
              ))}
            </TabList>
            {/* The page-level gap under a tab bar is for panels that sit on the page;
                inside the card the step's own padding is the spacing. */}
            <TabPanels className="mt-0">
              {CLIENTS.map((client) => (
                <TabPanel key={client.id} className="divide-y divide-zinc-100">
                  <ClientSteps snippet={snippets[client.id]} isCli={client.id === 'cli'} />
                </TabPanel>
              ))}
            </TabPanels>
          </Tabs>
        </Card>
      </section>
    </div>
  );
}

/**
 * What every snippet assumes exists, said once before any code. In a region
 * that creates buckets over S3 it points at the CLI's optional step, which
 * carries the command itself; a long command in running text wrapped mid-URL
 * and had no copy button.
 */
export function BucketPrerequisite({ region }: { region: S3Region }) {
  return (
    <p className="mb-3 text-sm text-(--color-paragraph-text)">
      You need an API key and a bucket. Create a bucket in{' '}
      <Link
        to="/buckets"
        className="rounded-md font-medium text-brand-600 transition-colors hover:text-brand-700 hover:underline focus-visible:brand-outline"
      >
        Buckets
      </Link>
      {supportsBucketManagement(region) ? ", or with the AWS CLI's optional step below." : '.'}
    </p>
  );
}

/**
 * Region, endpoint and the path-style requirement: what every client is
 * configured with. Labels and the select are 13px; the monospace values are
 * 12px, because monospace reads a step larger than sans at the same size.
 * Below `sm` each label sits above its value, so the values get the full width.
 */
function ConnectionFacts({
  region,
  onRegionChange,
  endpoint,
}: {
  region: S3Region;
  onRegionChange: (region: S3Region) => void;
  endpoint: string;
}) {
  return (
    <section>
      <Heading tag="h3" size="sm" className="mb-3">
        Connection
      </Heading>
      <Card padding="none" className="overflow-hidden">
        <dl className="divide-y divide-zinc-100">
          <div className="flex min-h-12 flex-col items-start gap-1 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-3 sm:py-2">
            <dt className="shrink-0 text-ui text-(--color-paragraph-text-subtle) sm:w-24">
              <label htmlFor="connection-region">Region</label>
            </dt>
            <dd className="min-w-0 flex-1">
              <RegionSelect
                id="connection-region"
                value={region}
                onChange={onRegionChange}
                size="sm"
                className="max-w-80"
              />
            </dd>
          </div>
          <div className="group flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 sm:flex-nowrap sm:py-2">
            <dt className="shrink-0 basis-full text-ui text-(--color-paragraph-text-subtle) sm:w-24 sm:basis-auto">
              S3 endpoint
            </dt>
            <dd className="min-w-0 flex-1 truncate font-mono text-xs text-(--color-text-base)">
              {endpoint}
            </dd>
            <span className="shrink-0 transition pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:focus-within:opacity-100">
              <CopyButton value={endpoint} />
            </span>
          </div>
          <div className="flex min-h-12 flex-col items-start gap-1 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-3 sm:py-2">
            <dt className="shrink-0 text-ui text-(--color-paragraph-text-subtle) sm:w-24">
              Path style
            </dt>
            <dd className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-ui">
              {/* Named by what it is, since each client spells the option its
                  own way; every snippet below sets it. */}
              <span className="text-(--color-text-base)">Path-style addressing</span>
              <Badge color="grey" size="sm">
                required
              </Badge>
              <span className="text-(--color-paragraph-text-subtle)">
                Set in every snippet below
              </span>
            </dd>
          </div>
        </dl>
      </Card>
    </section>
  );
}

/**
 * The two steps every client shares: set it up, then upload a file. The CLI
 * adds an optional bucket step between them, in a region that allows it.
 */
function ClientSteps({ snippet, isCli }: { snippet: ConnectionSnippet; isCli: boolean }) {
  return (
    <>
      <Step n={1} title={isCli ? 'Configure the CLI' : 'Set up the client'}>
        <div className="flex flex-col gap-2">
          <CodeBlock minimal language={isCli ? snippet.language : 'shell'} code={snippet.setup} />
          {snippet.client && (
            <CodeBlock minimal language={snippet.language} code={snippet.client} />
          )}
        </div>
      </Step>
      {snippet.createBucket && (
        <Step n={2} title="Create a bucket (optional)">
          <CodeBlock minimal language={snippet.language} code={snippet.createBucket} />
        </Step>
      )}
      <Step n={snippet.createBucket ? 3 : 2} title="Upload a file">
        <CodeBlock minimal language={snippet.language} code={snippet.upload} />
      </Step>
    </>
  );
}

/** A numbered step: a small index chip and its title, above its code. */
function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3.5">
      <div className="mb-2 flex items-center gap-2.5">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-medium text-zinc-600">
          {n}
        </span>
        <span className="text-sm font-medium text-(--color-paragraph-text-strong)">{title}</span>
      </div>
      <div className="pl-7.5">{children}</div>
    </div>
  );
}
