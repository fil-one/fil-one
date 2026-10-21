import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ArrowLeftIcon } from '@phosphor-icons/react/dist/ssr';

import type { CreateAccessKeyResponse } from '@filone/shared';
import { S3_REGION, type S3Region } from '@filone/shared';
import { Heading } from '../components/Heading/Heading';
import { AccessKeyFormFields } from '../components/AccessKeyFormFields.js';
import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';
import { IconButton } from '../components/IconButton.js';
import { InfoAside } from '../components/InfoAside.js';
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
  const [region, setRegion] = useState<S3Region>(S3_REGION);

  const form = useAccessKeyForm({
    region,
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
      <div className="mx-auto max-w-4xl px-5 pt-6 sm:px-8 lg:px-10 lg:pt-10">
        {/* Header */}
        <div className="mb-8 flex items-center gap-3">
          <IconButton
            icon={ArrowLeftIcon}
            aria-label="Back to API keys"
            onClick={() => void navigate({ to: '/api-keys' })}
          />
          <div>
            <Heading id="create-api-key-heading" tag="h1">
              Create API key
            </Heading>
            <p className="text-sm text-zinc-500">
              Generate credentials for S3-compatible API access
            </p>
          </div>
        </div>

        {/* Two columns once both fit beside the app sidebar; stacked below that */}
        <div className="flex flex-col gap-6 xl:flex-row xl:gap-10">
          {/* Left: form */}
          <Card className="w-full max-w-[520px] shrink-0">
            <form onSubmit={form.handleSubmit} className="flex flex-col gap-5">
              <AccessKeyFormFields form={form} region={region} onRegionChange={setRegion} />

              <Button
                id="create-api-key-submit-button"
                type="submit"
                variant="primary"
                size="lg"
                disabled={!form.canSubmit}
                loading={form.creating}
                loadingLabel="Creating API key"
              >
                Create API key
              </Button>
            </form>
          </Card>

          <InfoAside
            title="Good to know"
            items={[
              {
                title: 'Keep your secret safe',
                description:
                  'Your secret access key grants full access to your data. Never share it with anyone, including support. Store it in a secure location like a password manager or secrets vault.',
              },
              form.keyType === 'principal'
                ? {
                    title: 'Follows the bucket policies',
                    description:
                      "This key can do whatever each bucket's policy lets you do, and changes to a policy reach it without reissuing it.",
                  }
                : {
                    title: 'Scope by bucket',
                    description:
                      'Restrict keys to specific buckets to follow the principle of least privilege.',
                  },
              {
                title: 'Set an expiry',
                description:
                  'Keys can be set to expire automatically. Use short-lived keys for temporary access.',
              },
            ]}
          />
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
