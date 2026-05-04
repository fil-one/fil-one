import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ArrowLeftIcon } from '@phosphor-icons/react/dist/ssr';

import type { CreateAccessKeyResponse } from '@filone/shared';
import { AccessKeyFormFields } from '../components/AccessKeyFormFields.js';
import { Heading } from '../components/Heading/Heading';
import { Button } from '../components/Button.js';
import { IconButton } from '../components/IconButton.js';
import { SaveCredentialsModal } from '../components/SaveCredentialsModal.js';
import { useAccessKeyForm } from '../lib/use-access-key-form.js';

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function CreateApiKeyPage() {
  const navigate = useNavigate();
  const [credentials, setCredentials] = useState<{
    accessKeyId: string;
    secretAccessKey: string;
  } | null>(null);

  const form = useAccessKeyForm({
    onSuccess: (response: CreateAccessKeyResponse) => {
      setCredentials({
        accessKeyId: response.accessKeyId,
        secretAccessKey: response.secretAccessKey,
      });
    },
  });

  function handleCredentialsDone() {
    void navigate({ to: '/api-keys' });
  }

  return (
    <>
      <div className="mx-auto max-w-4xl px-10 pt-10">
        {/* Header */}
        <div className="mb-8 flex items-center gap-3">
          <IconButton
            icon={ArrowLeftIcon}
            aria-label="Back to API keys"
            onClick={() => void navigate({ to: '/api-keys' })}
          />
          <div>
            <Heading tag="h1">Create API key</Heading>
            <p className="text-sm text-zinc-500">
              Generate credentials for S3-compatible API access
            </p>
          </div>
        </div>

        {/* Two-column layout */}
        <div className="flex gap-8">
          {/* Left: form */}
          <form onSubmit={form.handleSubmit} className="flex flex-1 flex-col gap-6">
            <div className="rounded-lg border border-zinc-200 bg-white p-6">
              <AccessKeyFormFields form={form} />
            </div>

            <Button type="submit" variant="primary" disabled={!form.canSubmit}>
              {form.creating ? 'Creating...' : 'Create API key'}
            </Button>
          </form>

          {/* Right: info panel */}
          <div className="w-64 shrink-0">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Good to know
            </p>
            <p className="mb-4 text-sm font-medium text-zinc-700">
              Keep these in mind when creating keys.
            </p>
            <div className="flex flex-col gap-4 text-sm text-zinc-600">
              <div>
                <p className="mb-1 font-medium text-zinc-800">Keep your secret safe</p>
                <p>
                  Your secret access key grants full access to your data. Never share it with
                  anyone, including support. Store it in a secure location like a password manager
                  or secrets vault.
                </p>
              </div>
              <div>
                <p className="mb-1 font-medium text-zinc-800">Scope by bucket</p>
                <p>Restrict keys to specific buckets to follow the principle of least privilege.</p>
              </div>
              <div>
                <p className="mb-1 font-medium text-zinc-800">Set an expiry</p>
                <p>
                  Keys can be set to expire automatically. Use short-lived keys for temporary
                  access.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {credentials && (
        <SaveCredentialsModal
          open={true}
          onDone={handleCredentialsDone}
          credentials={credentials}
        />
      )}
    </>
  );
}
