import type { Meta, StoryObj } from '@storybook/react-vite';

import { DeleteAccountModal } from './DeleteAccountModal';

const meta: Meta<typeof DeleteAccountModal> = {
  title: 'Components/DeleteAccountModal',
  component: DeleteAccountModal,
  args: {
    open: true,
    orgName: 'Acme Corp',
    soleMembership: true,
    onClose: () => {},
    onDeleted: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof DeleteAccountModal>;

/**
 * The first step, and the only one reachable from props alone: the code-entry
 * step is driven by internal state that only a successful `POST
 * /api/account/deletion` produces, and Storybook has no API mocking configured.
 *
 * The warning has to carry its weight here, because this is the last screen
 * before an irreversible action with no grace period and no restore.
 */
export const Warning: Story = {};

/** Belonging to another org too changes the warning: the account survives. */
export const WarningWithOtherOrgs: Story = {
  args: { soleMembership: false },
};

/** A long org name must wrap in the header description and in the typed-to-confirm label. */
export const LongOrgName: Story = {
  args: { orgName: 'Acme Production Customer Support and Archival Services' },
};

/** An org name with characters the current OrgNameSchema would reject still has to render. */
export const AwkwardOrgName: Story = {
  args: { orgName: "Ben & Jerry's (EU)" },
};
