import type { Preview } from '@storybook/react-vite';
import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole } from '@filone/shared';
import '../src/styles.css';
import { ToastProvider } from '../src/components/Toast';
import { queryKeys } from '../src/lib/query-client.js';
import { seedPermissions } from '../src/lib/test-permissions.js';

/**
 * Every story renders as an Owner unless it says otherwise.
 *
 * Permission-gated surfaces are hidden until `/me` answers, and in Storybook it
 * never does — so a gated control simply was not in its own story. A client per
 * story, seeded before first render, gives each story the role it is about:
 * `parameters: { role: OrgRole.Member }` on a story or its meta.
 *
 * The app sets its `/me` staleTime at the key rather than at each hook, and the
 * seeded role has to inherit that: an observer without one treats the seed as
 * stale on mount and refetches, and there is no server behind a story to answer.
 */
function usePreviewClient(role: OrgRole) {
  return useMemo(() => {
    const created = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    created.setQueryDefaults(queryKeys.me, { staleTime: Infinity });
    seedPermissions(created, role);
    return created;
  }, [role]);
}

const preview: Preview = {
  decorators: [
    (Story, context) => {
      // Full-page stories paint their own ground; the padded white frame would
      // misrepresent them as floating on a white page.
      const fullBleed = Boolean(context.parameters.fullBleed);
      const role = (context.parameters.role as OrgRole | undefined) ?? OrgRole.Owner;
      const queryClient = usePreviewClient(role);
      return (
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <div className={fullBleed ? 'light-section' : 'light-section bg-white p-8'}>
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
      // Headless UI renders focus-guard <button> sentinels with aria-hidden="true"
      // as part of its focus-trap implementation. Axe flags these as
      // aria-hidden-focus, but they're intentional — exclude them from checks.
      context: {
        exclude: [['[data-headlessui-focus-guard]']],
      },
    },
  },
};

export default preview;
