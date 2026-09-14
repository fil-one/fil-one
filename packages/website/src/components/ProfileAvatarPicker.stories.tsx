import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MeResponse } from '@filone/shared';

import { ToastProvider } from './Toast/ToastProvider';
import { ProfileAvatarPicker } from './ProfileAvatarPicker';

const BASE_ME: MeResponse = {
  orgId: 'org_acme',
  orgName: 'Acme Inc.',
  slug: 'acme-inc',
  nameConfirmed: true,
  emailVerified: true,
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  mfaEnrollments: [],
  ragAccess: false,
  orgsBeta: false,
};

function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

const meta: Meta<typeof ProfileAvatarPicker> = {
  title: 'Components/ProfileAvatarPicker',
  component: ProfileAvatarPicker,
  decorators: [
    (Story) => (
      <QueryClientProvider client={createQueryClient()}>
        <ToastProvider>
          <Story />
        </ToastProvider>
      </QueryClientProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof ProfileAvatarPicker>;

/** No picture yet: the monogram fallback. */
export const Monogram: Story = {
  args: { me: BASE_ME },
};

export const WithPicture: Story = {
  args: {
    me: { ...BASE_ME, picture: 'https://avatars.githubusercontent.com/u/9919?s=64&v=4' },
  },
};
