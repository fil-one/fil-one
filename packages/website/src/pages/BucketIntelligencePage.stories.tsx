import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { queryKeys } from '../lib/query-client.js';
import { seedPermissions } from '../lib/test-permissions.js';
import { BucketIntelligencePage } from './BucketIntelligencePage';

const meta: Meta<typeof BucketIntelligencePage> = {
  title: 'Pages/BucketIntelligencePage',
  component: BucketIntelligencePage,
  parameters: { fullBleed: true },
};

export default meta;
type Story = StoryObj<typeof BucketIntelligencePage>;

/**
 * A client whose queries under `keys` are stuck in flight (`pending`) or have
 * already failed (`failed`), and never fetch again. The page passes its own
 * `queryFn`, which would win over one set here, so the outcome is stored once
 * and every refetch trigger is switched off instead. Kept out of garbage
 * collection, since the story may open long after this file loads.
 */
function clientWith(outcome: 'pending' | 'failed', keys: readonly (readonly unknown[])[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const queryKey of keys) {
    client.setQueryDefaults(queryKey, {
      gcTime: Infinity,
      staleTime: Infinity,
      retryOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    });
    void client.prefetchQuery({
      queryKey,
      queryFn: () =>
        outcome === 'pending'
          ? new Promise(() => {})
          : Promise.reject(new Error('Profile unavailable')),
    });
  }
  return client;
}

function withClient(client: QueryClient): Story['decorators'] {
  return [
    (Story) => (
      <QueryClientProvider client={client}>
        <Story />
      </QueryClientProvider>
    ),
  ];
}

/** `/me` has not answered yet, as after an organization switch clears it. */
export const LoadingAccount: Story = {
  decorators: withClient(clientWith('pending', [queryKeys.me])),
};

/** `/me` failed, so the page cannot tell whether the caller may use the feature. */
export const AccountUnavailable: Story = {
  decorators: withClient(clientWith('failed', [queryKeys.me])),
};

/** An allowlisted caller whose buckets and keys are still loading. */
export const LoadingBuckets: Story = {
  decorators: withClient(
    (() => {
      const client = clientWith('pending', [queryKeys.ragBuckets, queryKeys.ragApiKeys]);
      seedPermissions(client, undefined, { ragAccess: true });
      client.setQueryDefaults(queryKeys.me, { staleTime: Infinity });
      return client;
    })(),
  ),
};
