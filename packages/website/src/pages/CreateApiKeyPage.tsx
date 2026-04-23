import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ArrowLeftIcon } from '@phosphor-icons/react/dist/ssr';

import type { CreateAccessKeyResponse } from '@filone/shared';
import { AccessKeyFormFields } from '../components/AccessKeyFormFields.js';
import { Button } from '../components/Button.js';
import { InfoSidebar } from '../components/InfoSidebar.js';
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
      <div className="mx-auto max-w-4xl p-8">
        {/* Header */}
        <div className="mb-8 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void navigate({ to: '/api-keys' })}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
            aria-label="Back to API keys"
          >
            <ArrowLeftIcon size={16} />
          </button>
          <div>
            <h1 className="text-xl font-semibold text-zinc-900">Create API key</h1>
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

          {/* Right: info sidebar */}
          <div className="sticky top-0 w-60 shrink-0 self-start pt-1">
            <InfoSidebar
              heading="About API keys"
              items={[
                {
                  title: 'Scoped access',
                  description: 'Keys can be restricted to specific buckets and permissions.',
                },
                {
                  title: 'Secure credentials',
                  description:
                    'The secret key is only shown once at creation time. Store it somewhere safe.',
                },
                {
                  title: 'Revocable',
                  description: 'Delete a key at any time to immediately revoke access.',
                },
                {
                  title: 'Expiration',
                  description: 'Optionally set an expiry date so keys rotate automatically.',
                },
              ]}
            />
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
