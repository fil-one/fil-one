import { useEffect, useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { PreferencesResponse, UpdatePreferencesRequest } from '@filone/shared';

import { NotificationSettings } from './NotificationsSettings';
import { ToastProvider } from './Toast';

type SeedMode = 'optedOut' | 'optedIn' | 'loading';
type SaveBehavior = 'instant' | 'slow' | 'error';

type Args = {
  initialState: SeedMode;
  saveBehavior: SaveBehavior;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function never(): Promise<Response> {
  return new Promise<Response>(() => {
    /* deliberately unresolved — keeps the query in "loading" */
  });
}

function resolveUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function useMockPreferencesApi(initial: SeedMode, behavior: SaveBehavior) {
  useEffect(() => {
    const realFetch = globalThis.fetch.bind(globalThis);
    let current: PreferencesResponse = { marketingEmailsOptedIn: initial === 'optedIn' };

    const handleGet = (): Promise<Response> => {
      if (initial === 'loading') return never();
      return Promise.resolve(jsonResponse(current));
    };

    const handlePatch = async (init: RequestInit | undefined): Promise<Response> => {
      if (behavior === 'slow') await delay(1500);
      if (behavior === 'error') return jsonResponse({ message: 'Could not save preferences' }, 500);
      const body = JSON.parse((init?.body as string) ?? '{}') as UpdatePreferencesRequest;
      current = { ...current, ...body };
      return jsonResponse(current);
    };

    const handler: typeof fetch = async (input, init) => {
      const url = resolveUrl(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (!url.endsWith('/api/me/preferences')) return realFetch(input, init);
      if (method === 'GET') return handleGet();
      if (method === 'PATCH') return handlePatch(init);
      return realFetch(input, init);
    };

    globalThis.fetch = handler;
    return () => {
      globalThis.fetch = realFetch;
    };
  }, [initial, behavior]);
}

const meta: Meta<Args> = {
  title: 'Pages/Settings/NotificationsSection',
  argTypes: {
    initialState: {
      control: 'select',
      options: ['optedOut', 'optedIn', 'loading'],
    },
    saveBehavior: {
      control: 'select',
      options: ['instant', 'slow', 'error'],
    },
  },
  args: {
    initialState: 'optedOut',
    saveBehavior: 'instant',
  },
  parameters: { layout: 'padded' },
  render: ({ initialState, saveBehavior }) => {
    useMockPreferencesApi(initialState, saveBehavior);
    const [queryClient] = useState(
      () =>
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        }),
    );
    return (
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <div style={{ maxWidth: 672 }}>
            <NotificationSettings />
          </div>
        </ToastProvider>
      </QueryClientProvider>
    );
  },
};

export default meta;
type Story = StoryObj<Args>;

export const MarketingOff: Story = {
  args: { initialState: 'optedOut', saveBehavior: 'instant' },
};

export const MarketingOn: Story = {
  args: { initialState: 'optedIn', saveBehavior: 'instant' },
};

export const Loading: Story = {
  args: { initialState: 'loading', saveBehavior: 'instant' },
};

export const SlowSave: Story = {
  args: { initialState: 'optedOut', saveBehavior: 'slow' },
};

export const SaveError: Story = {
  args: { initialState: 'optedOut', saveBehavior: 'error' },
};
