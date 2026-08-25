// design-sync preview wrapper: mirrors .storybook/preview.tsx's decorator chain
// (QueryClientProvider + ToastProvider + light-section frame) for the synced
// component previews on claude.ai/design.
import { useState, type ReactNode } from 'react';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ToastProvider } from './src/components/Toast';

export function PreviewProviders({ children }: { children?: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <div className="light-section bg-white p-8">{children}</div>
      </ToastProvider>
    </QueryClientProvider>
  );
}
