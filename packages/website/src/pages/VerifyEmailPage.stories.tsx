import type { Meta, StoryObj } from '@storybook/react-vite';
import type { MeResponse } from '@filone/shared';

import { VerifyEmailPage } from './VerifyEmailPage';

const me: MeResponse = {
  orgId: 'org_acme',
  orgName: 'Acme Inc.',
  nameConfirmed: true,
  emailVerified: false,
  email: 'jane@acme.com',
  mfaEnrollments: [],
  ragAccess: false,
  orgsBeta: false,
};

const meta: Meta<typeof VerifyEmailPage> = {
  title: 'Pages/VerifyEmailPage',
  component: VerifyEmailPage,
  parameters: { fullBleed: true, layout: 'fullscreen' },
  args: {
    me,
    onVerified: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof VerifyEmailPage>;

export const Default: Story = {};

export const LongEmail: Story = {
  args: {
    me: { ...me, email: 'jane.appleseed.engineering@a-long-company-domain.example.com' },
  },
};
