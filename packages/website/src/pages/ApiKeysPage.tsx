import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  DatabaseIcon,
  PlusIcon,
} from '@phosphor-icons/react/dist/ssr';

import { AccessKeysTable } from '../components/AccessKeysTable';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { CopyButton } from '../components/CopyButton';
import { Heading } from '../components/Heading/Heading';
import { PageLayout } from '../components/PageLayout.js';
import { CodeBlock } from '../components/CodeBlock';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Spinner } from '../components/Spinner';
import { Tab, TabList, TabPanel, TabPanels, Tabs } from '../components/Tabs';
import { useToast } from '../components/Toast';

import type { AccessKey, ListAccessKeysResponse, S3Region } from '@filone/shared';

import {
  getS3Endpoint,
  getRegionLabel,
  supportsBucketManagement,
  S3_REGION,
  DOCS_URL,
} from '@filone/shared';
import { RegionSelect } from '../components/RegionSelect';
import { FILONE_STAGE } from '../env';
import { apiRequest } from '../lib/api.js';
import { queryKeys } from '../lib/query-client.js';

// ---------------------------------------------------------------------------
// Tab 1: Access Keys
// ---------------------------------------------------------------------------

type AccessKeysTabProps = {
  keys: AccessKey[];
  onCreateOpen: () => void;
  onDelete: (id: string) => Promise<void>;
  onBulkDelete: (ids: string[]) => Promise<void>;
};

function AccessKeysTab({ keys, onCreateOpen, onDelete, onBulkDelete }: AccessKeysTabProps) {
  return (
    <>
      <AccessKeysTable
        keys={keys}
        showRegion
        showBuckets
        showPermissions
        showCreated
        onDelete={onDelete}
        onBulkDelete={onBulkDelete}
        onCreateOpen={onCreateOpen}
      />
      {keys.length === 0 && (
        <div className="mt-6 flex justify-center">
          <Button variant="tertiary" icon={DatabaseIcon} href="/buckets">
            Manage buckets
          </Button>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Tab 2: Connection Details
// ---------------------------------------------------------------------------

/** A single numbered step: a small index chip plus its title, sitting above its
 * code sample. Shared by the Quickstart and SDK example cards. */
function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3.5">
      <div className="mb-2 flex items-center gap-2.5">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-600">
          {n}
        </span>
        <span className="text-sm font-medium text-(--color-paragraph-text-strong)">{title}</span>
      </div>
      <div className="pl-[1.9rem]">{children}</div>
    </div>
  );
}

// eslint-disable-next-line max-lines-per-function
function ConnectionDetailsTab({ onViewKeys }: { onViewKeys: () => void }) {
  const [region, setRegion] = useState<S3Region>(S3_REGION);
  const s3Endpoint = getS3Endpoint(region, FILONE_STAGE);
  const [sdkTab, setSdkTab] = useState<'python' | 'nodejs' | 'go'>('python');

  const pythonInstall = `pip install boto3`;
  const pythonUpload = `import boto3

s3 = boto3.client(
    "s3",
    endpoint_url="${s3Endpoint}",
    aws_access_key_id="YOUR_ACCESS_KEY",
    aws_secret_access_key="YOUR_SECRET_KEY",
    region_name="${region}",
)

# Upload
s3.upload_file("local-file.parquet", "my-bucket", "data/file.parquet")

# Download
s3.download_file("my-bucket", "data/file.parquet", "local-copy.parquet")

# List objects
for obj in s3.list_objects_v2(Bucket="my-bucket").get("Contents", []):
    print(obj["Key"], obj["Size"])`;

  const nodejsInstall = `npm install @aws-sdk/client-s3`;
  const nodejsUpload = `import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createReadStream } from "fs";

const s3 = new S3Client({
  endpoint: "${s3Endpoint}",
  region: "${region}",
  credentials: {
    accessKeyId: "YOUR_ACCESS_KEY",
    secretAccessKey: "YOUR_SECRET_KEY",
  },
  forcePathStyle: true,
});

await s3.send(new PutObjectCommand({
  Bucket: "my-bucket",
  Key: "data/file.parquet",
  Body: createReadStream("./local-file.parquet"),
}));`;

  const goInstall = `go get github.com/aws/aws-sdk-go-v2/service/s3`;
  const goUpload = `import (
    "github.com/aws/aws-sdk-go-v2/aws"
    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/service/s3"
)

cfg, _ := config.LoadDefaultConfig(context.TODO(),
    config.WithRegion("${region}"),
    config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
        "YOUR_ACCESS_KEY", "YOUR_SECRET_KEY", "",
    )),
)

client := s3.NewFromConfig(cfg, func(o *s3.Options) {
    o.BaseEndpoint = aws.String("${s3Endpoint}")
    o.UsePathStyle = true
})`;

  const SDK_META = {
    python: { install: pythonInstall, upload: pythonUpload, lang: 'python' },
    nodejs: { install: nodejsInstall, upload: nodejsUpload, lang: 'javascript' },
    go: { install: goInstall, upload: goUpload, lang: 'go' },
  } as const;

  return (
    <div className="mt-6 flex flex-col gap-10">
      {/* Connection: the canonical facts you need to connect. Region leads since it drives the rest. */}
      <section>
        <Heading tag="h3" size="sm" className="mb-3">
          Connection
        </Heading>
        <Card padding="none" className="overflow-hidden">
          <dl className="divide-y divide-zinc-100">
            <div className="flex min-h-12 items-center gap-3 px-4 py-2">
              <dt className="w-24 shrink-0 text-sm text-(--color-paragraph-text-subtle)">
                <label htmlFor="connection-region">Region</label>
              </dt>
              <dd className="min-w-0 flex-1">
                <div className="w-60 [&_select]:py-1.5 [&_select]:pr-8 [&_select]:text-xs">
                  <RegionSelect id="connection-region" value={region} onChange={setRegion} />
                </div>
              </dd>
            </div>
            <div className="group flex min-h-12 items-center gap-3 px-4 py-2">
              <dt className="w-24 shrink-0 text-sm text-(--color-paragraph-text-subtle)">
                S3 Endpoint
              </dt>
              <dd className="min-w-0 flex-1 truncate font-mono text-sm text-(--color-text-base)">
                {s3Endpoint}
              </dd>
              <span className="shrink-0 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100 max-sm:opacity-100">
                <CopyButton value={s3Endpoint} />
              </span>
            </div>
            <div className="flex min-h-12 items-center gap-3 px-4 py-2">
              <dt className="w-24 shrink-0 text-sm text-(--color-paragraph-text-subtle)">
                Credentials
              </dt>
              <dd className="min-w-0 flex-1 text-sm text-(--color-paragraph-text-strong)">
                Your Fil One key + secret
              </dd>
              <button
                type="button"
                onClick={onViewKeys}
                className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-brand-600 transition-colors hover:text-brand-700"
              >
                View keys
                <ArrowRightIcon size={12} weight="bold" />
              </button>
            </div>
            <div className="flex min-h-12 items-center gap-3 px-4 py-2">
              <dt className="w-24 shrink-0 text-sm text-(--color-paragraph-text-subtle)">
                Path style
              </dt>
              <dd className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                <span className="font-mono text-(--color-text-base)">forcePathStyle: true</span>
                <Badge color="grey" size="sm">
                  required
                </Badge>
              </dd>
            </div>
          </dl>
        </Card>
      </section>

      {/* Quickstart: the fastest path — copy-paste shell commands */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <Heading tag="h3" size="sm">
            Quickstart (AWS CLI)
          </Heading>
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 transition-colors hover:text-brand-700 hover:underline"
          >
            View docs
            <ArrowUpRightIcon size={12} weight="bold" />
          </a>
        </div>
        <Card padding="none" className="divide-y divide-zinc-100 overflow-hidden">
          <Step n={1} title="Configure your S3 client">
            <CodeBlock
              minimal
              code={`aws configure set aws_access_key_id YOUR_ACCESS_KEY\naws configure set aws_secret_access_key YOUR_SECRET_KEY\naws configure set default.region ${region}`}
            />
          </Step>
          <Step n={2} title="Create a bucket">
            {supportsBucketManagement(region) ? (
              <CodeBlock minimal code={`aws s3 mb s3://my-bucket --endpoint-url ${s3Endpoint}`} />
            ) : (
              <p className="text-sm text-(--color-paragraph-text)">
                {getRegionLabel(region)} doesn&apos;t support creating buckets over the S3 API.
                Create one in the{' '}
                <a
                  href="/buckets"
                  className="font-medium text-brand-600 transition-colors hover:text-brand-700 hover:underline"
                >
                  Buckets
                </a>{' '}
                console instead.
              </p>
            )}
          </Step>
          <Step n={3} title="Upload a file">
            <CodeBlock
              minimal
              code={`aws s3 cp ./my-file.parquet s3://my-bucket/ --endpoint-url ${s3Endpoint}`}
            />
          </Step>
        </Card>
      </section>

      {/* SDK examples: code snippets, one language per tab */}
      <section>
        <Heading tag="h3" size="sm" className="mb-3">
          SDK examples
        </Heading>
        <Card padding="none" className="overflow-hidden">
          {/* Tab bar */}
          <div className="flex gap-1 overflow-x-auto border-b border-zinc-100 px-2">
            {(
              [
                ['python', 'Python'],
                ['nodejs', 'Node.js'],
                ['go', 'Go'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setSdkTab(key)}
                aria-pressed={sdkTab === key}
                className={`relative shrink-0 rounded-t px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-600 ${
                  sdkTab === key
                    ? 'text-brand-700'
                    : 'text-(--color-paragraph-text-subtle) hover:text-(--color-paragraph-text-strong)'
                }`}
              >
                {label}
                {sdkTab === key && (
                  <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-brand-600" />
                )}
              </button>
            ))}
          </div>
          {/* Content */}
          <div className="divide-y divide-zinc-100">
            <Step n={1} title="Install">
              <CodeBlock minimal code={SDK_META[sdkTab].install} />
            </Step>
            <Step n={2} title="Upload & retrieve">
              <CodeBlock minimal language={SDK_META[sdkTab].lang} code={SDK_META[sdkTab].upload} />
            </Step>
          </div>
        </Card>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** Copy for the delete-confirmation dialog, adapted to how many keys are selected. */
function deleteDialogCopy(count: number) {
  if (count > 1) {
    return {
      title: `Delete ${count} access keys`,
      description: `These ${count} access keys will be permanently revoked. Any applications using them will lose access immediately.`,
      confirmLabel: `Delete ${count} keys`,
    };
  }
  return {
    title: 'Delete access key',
    description:
      'This access key will be permanently revoked. Any applications using it will lose access immediately.',
    confirmLabel: 'Delete key',
  };
}

export function ApiKeysPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending, isError, error } = useQuery({
    queryKey: queryKeys.accessKeys,
    queryFn: () => apiRequest<ListAccessKeysResponse>('/access-keys'),
  });
  const keys = data?.keys ?? [];

  const [tabIndex, setTabIndex] = useState(0);
  const [confirmDeleteIds, setConfirmDeleteIds] = useState<string[] | null>(null);

  const deleteKeysMutation = useMutation({
    mutationFn: (ids: string[]) =>
      Promise.all(ids.map((id) => apiRequest(`/access-keys/${id}`, { method: 'DELETE' }))),
    onSuccess: (_, ids) => {
      const removed = new Set(ids);
      queryClient.setQueryData<ListAccessKeysResponse>(queryKeys.accessKeys, (old) =>
        old ? { keys: old.keys.filter((k) => !removed.has(k.id)) } : old,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.accessKeys });
      void queryClient.invalidateQueries({ queryKey: queryKeys.usage });
      toast.success(ids.length === 1 ? 'Access key deleted' : `${ids.length} access keys deleted`);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to delete keys');
    },
  });

  async function handleDelete(id: string) {
    setConfirmDeleteIds([id]);
  }

  async function handleBulkDelete(ids: string[]) {
    setConfirmDeleteIds(ids);
  }

  async function confirmDeleteAction() {
    if (!confirmDeleteIds) return;
    try {
      await deleteKeysMutation.mutateAsync(confirmDeleteIds);
    } catch {
      // error handled by mutation.onError
    }
  }

  const goToCreate = () => void navigate({ to: '/api-keys/create' });

  if (isPending) {
    return (
      <div className="flex items-center justify-center p-16">
        <Spinner ariaLabel="Loading access keys" size={32} />
      </div>
    );
  }

  if (isError) {
    return (
      <PageLayout
        title="API Keys"
        description="Manage credentials and connect via S3-compatible API"
      >
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error?.message ?? 'Failed to load access keys'}
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout
      title="API Keys"
      headingId="api-keys-heading"
      description="Manage credentials and connect via S3-compatible API"
      action={
        <Button
          id="api-keys-create-button"
          variant="ghost"
          size="sm"
          icon={PlusIcon}
          onClick={goToCreate}
        >
          Create new key
        </Button>
      }
    >
      <Tabs selectedIndex={tabIndex} onChange={setTabIndex}>
        <TabList>
          <Tab testId="api-keys-tab">API keys {keys.length > 0 && `(${keys.length})`}</Tab>
          <Tab testId="connection-details-tab">Connection details</Tab>
        </TabList>

        <TabPanels>
          <TabPanel>
            <AccessKeysTab
              keys={keys}
              onCreateOpen={goToCreate}
              onDelete={handleDelete}
              onBulkDelete={handleBulkDelete}
            />
          </TabPanel>
          <TabPanel>
            <ConnectionDetailsTab onViewKeys={() => setTabIndex(0)} />
          </TabPanel>
        </TabPanels>
      </Tabs>

      <ConfirmDialog
        open={confirmDeleteIds !== null}
        onClose={() => setConfirmDeleteIds(null)}
        onConfirm={confirmDeleteAction}
        {...deleteDialogCopy(confirmDeleteIds?.length ?? 0)}
      />
    </PageLayout>
  );
}
