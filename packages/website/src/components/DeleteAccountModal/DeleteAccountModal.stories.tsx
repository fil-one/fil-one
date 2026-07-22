import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent, waitFor, within } from 'storybook/test';

import { Button } from '../Button';
import { DeleteAccountModal } from './DeleteAccountModal';

const ORG_NAME = 'Acme Corp';

function ModalHost() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <Button variant="destructive" onClick={() => setOpen(true)}>
        Delete account…
      </Button>
      <DeleteAccountModal open={open} onClose={() => setOpen(false)} orgName={ORG_NAME} />
    </>
  );
}

const meta: Meta<typeof DeleteAccountModal> = {
  title: 'Components/DeleteAccountModal',
  component: DeleteAccountModal,
  render: () => <ModalHost />,
};

export default meta;
type Story = StoryObj<typeof DeleteAccountModal>;

/** The dialog portals to document.body, outside the story canvas. */
function body(canvasElement: HTMLElement) {
  return within(canvasElement.ownerDocument.body);
}

/**
 * Stub the challenge endpoint so the code step is reachable without a
 * backend; every other request falls through to the real fetch.
 */
function withChallengeStub(Story: React.ComponentType) {
  const originalFetch = window.fetch;
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/account/delete-challenge')) {
      return new Response(
        JSON.stringify({
          expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          resendAvailableAt: new Date(Date.now() + 60 * 1000).toISOString(),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return originalFetch(input, init);
  };
  return <Story />;
}

/** Step 1: the destructive action is locked behind typing the exact org name. */
export const ConfirmStep: Story = {};

/** Step 1 with the org name typed — "Send verification code" unlocks. */
export const NameTyped: Story = {
  play: async ({ canvasElement }) => {
    const dialog = body(canvasElement);
    await userEvent.type(await dialog.findByPlaceholderText(ORG_NAME), ORG_NAME);
  },
};

/** Step 2: the emailed 6-digit code gate, with the resend cooldown running. */
export const CodeStep: Story = {
  decorators: [withChallengeStub],
  play: async ({ canvasElement }) => {
    const dialog = body(canvasElement);
    await userEvent.type(await dialog.findByPlaceholderText(ORG_NAME), ORG_NAME);
    await userEvent.click(dialog.getByRole('button', { name: /send verification code/i }));
    await waitFor(() => dialog.getByPlaceholderText('123456'));
  },
};

/** Step 2 with a code entered — "Permanently delete account" unlocks. */
export const CodeEntered: Story = {
  decorators: [withChallengeStub],
  play: async ({ canvasElement }) => {
    const dialog = body(canvasElement);
    await userEvent.type(await dialog.findByPlaceholderText(ORG_NAME), ORG_NAME);
    await userEvent.click(dialog.getByRole('button', { name: /send verification code/i }));
    const codeInput = await dialog.findByPlaceholderText('123456');
    await userEvent.type(codeInput, '123456');
  },
};
