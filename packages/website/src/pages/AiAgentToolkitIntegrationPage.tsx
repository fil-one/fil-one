import { useState } from 'react';
import {
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  CaretRightIcon,
} from '@phosphor-icons/react/dist/ssr';
import { Link, useNavigate } from '@tanstack/react-router';

import { Badge } from '../components/Badge.js';
import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';
import { Heading } from '../components/Heading/Heading.js';
import { useAddOnState } from '../contexts/addOnState.js';
import { useIntegrationState } from '../contexts/integrationState.js';
import {
  INTEGRATIONS,
  IntegrationLogo,
  InstallBody,
  ManageBucketsModal,
  OAuthBody,
  PasteConfigBody,
  slugify,
} from './AiAgentToolkitPage.js';

export function AiAgentToolkitIntegrationPage({ slug }: { slug: string }) {
  const { states: addOnStates } = useAddOnState();
  const { states, connect, disconnect, setBuckets } = useIntegrationState();
  const navigate = useNavigate();
  const [editingBuckets, setEditingBuckets] = useState(false);

  const toolkitEnabled = addOnStates['/ai-agent-toolkit'] === 'active';
  const item = INTEGRATIONS.find((i) => slugify(i.name) === slug);

  if (!item) {
    return (
      <div className="px-10 py-12 pb-20 max-w-4xl">
        <Link
          to="/ai-agent-toolkit"
          className="mb-8 inline-flex items-center gap-1.5 text-sm text-zinc-500 transition-colors hover:text-zinc-900"
        >
          <ArrowLeftIcon size={14} weight="bold" />
          Back to AI Agent Toolkit
        </Link>
        <Heading tag="h1" size="xl">Integration not found</Heading>
        <p className="mt-2 text-sm text-zinc-500">We couldn't find an integration matching "{slug}".</p>
      </div>
    );
  }

  const isDocsOnly = item.group === 'code';

  if (!toolkitEnabled && !isDocsOnly) {
    // If toolkit got disabled while user was on this page, bounce home (gated items only).
    void navigate({ to: '/ai-agent-toolkit' });
    return null;
  }

  const state = states[item.name] ?? { status: 'available' as const, buckets: [] };
  const related = INTEGRATIONS.filter((i) => i.group === item.group && i.name !== item.name).slice(0, 3);

  function handleConfirm() {
    connect(item!.name, []);
  }

  function handleDisconnect() {
    disconnect(item!.name);
  }

  function handleSaveBuckets(buckets: string[]) {
    setBuckets(item!.name, buckets);
    setEditingBuckets(false);
  }

  return (
    <>
      <div className="px-10 py-12 pb-20 max-w-4xl">
        <Link
          to="/ai-agent-toolkit"
          className="mb-8 inline-flex items-center gap-1.5 text-sm text-zinc-500 transition-colors hover:text-zinc-900"
        >
          <ArrowLeftIcon size={14} weight="bold" />
          Back to AI Agent Toolkit
        </Link>

        <div className="mb-8 flex items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <IntegrationLogo item={item} size="lg" />
            <div>
              <Heading tag="h1" size="xl" className="mb-0.5">{item.name}</Heading>
              <p className="text-sm text-zinc-500">{item.subtitle}</p>
              {!isDocsOnly && (state.status === 'connected' || state.status === 'pending') && (
                <p className="mt-2 text-xs text-zinc-400">
                  Last active <span className="text-zinc-600">2 min ago</span>
                  <span aria-hidden="true"> · </span>
                  <span className="text-zinc-600">1,247</span> requests this month
                </p>
              )}
            </div>
          </div>
          {!isDocsOnly && (
            <div className="mt-1 flex flex-shrink-0 items-center gap-2">
              {state.status === 'connected' && (
                <>
                  <Badge color="green" size="sm" strength="strong">Connected</Badge>
                  <Button variant="tertiary" size="sm" onClick={handleDisconnect}>
                    Disconnect
                  </Button>
                </>
              )}
              {state.status === 'pending' && (
                <Badge color="amber" size="sm" strength="strong">Pending</Badge>
              )}
            </div>
          )}
        </div>

        {!isDocsOnly && (state.status === 'connected' || state.status === 'pending') && (
          <section className="mb-8">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Bucket access</p>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3">
              <p className="truncate text-sm text-zinc-700">
                {state.buckets.length === 0
                  ? 'All buckets'
                  : state.buckets.join(', ')}
              </p>
              <Button variant="ghost" size="sm" onClick={() => setEditingBuckets(true)}>
                Edit
              </Button>
            </div>
          </section>
        )}

        {isDocsOnly && (
          <section className="mb-8">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Bucket access</p>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3">
              <p className="text-sm text-zinc-600">
                Controlled by the API key you provide.{' '}
                <Link to="/api-keys" className="font-medium text-zinc-900 underline-offset-2 hover:underline">
                  Manage scopes on the API Keys page →
                </Link>
              </p>
            </div>
          </section>
        )}

        <section>
          <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
            {item.archetype === 'install' ? 'Install' : item.archetype === 'paste-config' ? 'Configuration' : 'Authorisation'}
          </p>
          {item.archetype === 'install' && (
            <InstallBody item={item} showHint={!isDocsOnly && state.status === 'available'} />
          )}
          {item.archetype === 'paste-config' && (
            <PasteConfigBody item={item} showHint={!isDocsOnly && state.status === 'available'} />
          )}
          {item.archetype === 'oauth' && (
            <OAuthBody item={item} showAction={state.status === 'available'} onAuthorise={handleConfirm} />
          )}
          <div className="mt-4">
            <a
              href="#"
              className="inline-flex items-center gap-1 text-xs font-medium text-zinc-600 transition-colors hover:text-zinc-900"
            >
              Read the {item.name} integration guide
              <ArrowSquareOutIcon size={12} weight="bold" />
            </a>
          </div>
        </section>

        {related.length > 0 && (
          <section className="mt-12 border-t border-zinc-200 pt-8">
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
              Related integrations
            </p>
            <Card padding="none" className="overflow-hidden divide-y divide-zinc-100">
              {related.map((r) => (
                <Link
                  key={r.name}
                  to="/ai-agent-toolkit/integrations/$slug"
                  params={{ slug: slugify(r.name) }}
                  className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-zinc-50"
                >
                  <IntegrationLogo item={r} />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <p className="truncate text-sm font-medium text-zinc-900">{r.name}</p>
                    <p className="truncate text-xs text-zinc-400">{r.subtitle}</p>
                  </div>
                  <CaretRightIcon size={14} weight="bold" className="text-zinc-300" />
                </Link>
              ))}
            </Card>
          </section>
        )}
      </div>

      {editingBuckets && (
        <ManageBucketsModal
          integration={item}
          currentBuckets={state.buckets}
          open={editingBuckets}
          onClose={() => setEditingBuckets(false)}
          onSave={handleSaveBuckets}
        />
      )}
    </>
  );
}
