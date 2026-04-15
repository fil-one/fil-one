import type { Preview } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/styles.css';
import { ToastProvider } from '../src/components/Toast';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

const preview: Preview = {
  decorators: [
    (Story) => {
      return (
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <div className="light-section bg-white p-8">
              <Story />
            </div>
          </ToastProvider>
        </QueryClientProvider>
      );
    },
  ],
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    a11y: {
      // 'todo' - show a11y violations in the test UI only
      // 'error' - fail CI on a11y violations
      // 'off' - skip a11y checks entirely
      test: 'todo',
    },
  },
};

export default preview;
