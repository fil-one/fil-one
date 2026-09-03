import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { CopySimpleIcon, DatabaseIcon, PlusIcon } from '@phosphor-icons/react/dist/ssr';

import { AccessKeysTable } from '../components/AccessKeysTable';
import { Alert } from '../components/Alert';
import { Button } from '../components/Button';
import { Heading } from '../components/Heading/Heading';
import { PageLayout } from '../components/PageLayout.js';
import { CodeBlock } from '../components/CodeBlock';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Tab, TabList, TabPanel, TabPanels, Tabs } from '../components/Tabs';
import { TableSkeleton, type SkeletonColumn } from '../components/Table/TableSkeleton';
import { useToast } from '../components/Toast';

import type { AccessKey, ListAccessKeysResponse, S3Region } from '@filone/shared';

import { getS3Endpoint, S3_REGION, DOCS_URL } from '@filone/shared';
import { RegionSelect } from '../components/RegionSelect';
import { FILONE_STAGE } from '../env';
import { apiRequest } from '../lib/api.js';
import { useKeyCreators } from '../lib/use-key-creators.js';
import { useCopyToClipboard } from '../lib/use-copy-to-clipboard.js';
import { LIST_GC_TIME, LIST_STALE_TIME, queryKeys } from '../lib/query-client.js';
import { RequirePermission } from '../components/RequirePermission';
import { useHasPermission } from '../lib/use-permissions.js';
import { useKeyActionScope } from '../lib/use-key-scope.js';
import { useAccountDisabled } from '../lib/use-account-disabled.js';
import { useOrgSlug } from '../lib/use-org-path.js';

// ---------------------------------------------------------------------------
// Tab 1: Access Keys
// ---------------------------------------------------------------------------

// Mirrors AccessKeysTable at its widest (showRegion + showBuckets +
// showPermissions), matching each column's breakpoint so the loading
// placeholder hides the same columns as the real table.
const SKELETON_COLUMNS: SkeletonColumn[] = [
  { label: 'Name' },
  { label: 'Region', className: 'hidden md:table-cell' },
  { label: 'Buckets', className: 'hidden lg:table-cell' },
  { label: 'Permissions', className: 'hidden md:table-cell' },
  { label: 'Status', className: 'hidden sm:table-cell' },
  { label: 'Last Used', className: 'hidden md:table-cell' },
  {},
];

type AccessKeysTabProps = {
  keys: AccessKey[];
  /** Absent for a role that cannot mint keys — the table drops the control. */
  onCreateOpen?: () => void;
  /** Absent for a role that cannot revoke them — the table drops the column. */
  onDelete?: (id: string) => Promise<void>;
  /** Whether a row's Revoke belongs to this caller. */
  canRevoke?: (key: AccessKey) => boolean;
  creatorFor?: (userId: string) => { name: string; email?: string } | undefined;
};

function AccessKeysTab({
  keys,
  onCreateOpen,
  onDelete,
  canRevoke,
  creatorFor,
}: AccessKeysTabProps) {
  return (
    <>
      <div className="mt-4 mb-4">
        <span className="text-sm text-zinc-600">
          {keys.length === 1 ? '1 key' : `${keys.length} keys`}
        </span>
      </div>

      <AccessKeysTable
        keys={keys}
        showRegion
        showBuckets
        showPermissions
        onDelete={onDelete}
        canDelete={canRevoke}
        creatorFor={creatorFor}
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

/**
 * The keys tab in each of its four states.
 *
 * All four live inside the tab rather than replacing the page, so the static
 * Connection details tab beside it survives a failed or refused keys request.
 */
function AccessKeysPanel({
  keys,
  mayList,
  isPending,
  isError,
  errorMessage,
  onCreateOpen,
  onDelete,
  canRevoke,
  creatorFor,
}: AccessKeysTabProps & {
  mayList: boolean;
  isPending: boolean;
  isError: boolean;
  errorMessage?: string;
}) {
  if (!mayList) {
    return (
      <div
        data-testid="api-keys-no-access"
        className="mt-4 rounded-lg border border-zinc-200 bg-white p-6 text-sm text-zinc-600"
      >
        Access keys are managed by members who can create them. Your role can browse buckets and
        objects; the connection details are in the next tab.
      </div>
    );
  }

  if (isPending) {
    return (
      <div className="mt-4">
        <TableSkeleton columns={SKELETON_COLUMNS} rows={4} aria-label="Loading access keys" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="mt-4">
        <Alert variant="red" description={errorMessage ?? 'Failed to load access keys'} />
      </div>
    );
  }

  return (
    <AccessKeysTab
      keys={keys}
      onCreateOpen={onCreateOpen}
      onDelete={onDelete}
      canRevoke={canRevoke}
      creatorFor={creatorFor}
    />
  );
}

// ---------------------------------------------------------------------------
// Tab 2: Connection Details
// ---------------------------------------------------------------------------

function CopyButton({ value }: { value: string }) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <button
      type="button"
      onClick={() => void copy(value)}
      title={copied ? 'Copied' : 'Copy'}
      aria-label={copied ? 'Copied to clipboard' : 'Copy to clipboard'}
      className="ml-2 shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
    >
      <CopySimpleIcon size={14} />
    </button>
  );
}

// eslint-disable-next-line max-lines-per-function
function ConnectionDetailsTab() {
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
    python: {
      label: 'Python',
      hint: 'Using boto3 (AWS SDK for Python)',
      install: pythonInstall,
      upload: pythonUpload,
      lang: 'python',
    },
    nodejs: {
      label: 'Node.js',
      hint: 'Using @aws-sdk/client-s3',
      install: nodejsInstall,
      upload: nodejsUpload,
      lang: 'javascript',
    },
    go: {
      label: 'Go',
      hint: 'Using aws-sdk-go-v2',
      install: goInstall,
      upload: goUpload,
      lang: 'go',
    },
  } as const;

  const active = SDK_META[sdkTab];

  return (
    <div className="mt-4 flex flex-col gap-8">
      {/* Region selector */}
      <div className="flex items-center gap-3">
        <label htmlFor="connection-region" className="text-sm font-medium text-zinc-700">
          Region
        </label>
        <RegionSelect id="connection-region" value={region} onChange={setRegion} />
      </div>

      {/* Endpoint + Region card */}
      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <div className="flex items-center border-b border-zinc-100 px-4 py-3">
          <span className="w-28 shrink-0 text-sm text-zinc-500">S3 Endpoint</span>
          <span className="flex-1 font-mono text-sm text-zinc-900">{s3Endpoint}</span>
          <CopyButton value={s3Endpoint} />
        </div>
        <div className="flex items-center px-4 py-3">
          <span className="w-28 shrink-0 text-sm text-zinc-500">Region</span>
          <span className="flex-1 font-mono text-sm text-zinc-900">{region}</span>
          <CopyButton value={region} />
        </div>
      </div>

      {/* Quickstart CLI */}
      <div>
        <div className="mb-4 flex items-center justify-between">
          <Heading tag="h3" size="sm">
            Quickstart (AWS CLI)
          </Heading>
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-medium text-brand-600 hover:underline"
          >
            View docs ↗
          </a>
        </div>
        <div className="flex flex-col gap-3">
          {[
            {
              n: 1,
              title: 'Configure your S3 client',
              code: `aws configure set aws_access_key_id YOUR_ACCESS_KEY\naws configure set aws_secret_access_key YOUR_SECRET_KEY\naws configure set default.region ${region}`,
            },
            {
              n: 2,
              title: 'Create a bucket',
              code: `aws s3 mb s3://my-bucket --endpoint-url ${s3Endpoint}`,
            },
            {
              n: 3,
              title: 'Upload a file',
              code: `aws s3 cp ./my-file.parquet s3://my-bucket/ --endpoint-url ${s3Endpoint}`,
            },
          ].map(({ n, title, code }) => (
            <div key={n} className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
              <div className="flex items-center gap-3 border-b border-zinc-100 px-4 py-2.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-600">
                  {n}
                </span>
                <span className="text-sm font-medium text-zinc-800">{title}</span>
              </div>
              <div className="px-4 py-3">
                <CodeBlock language="sh" code={code} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* SDK Examples */}
      <div>
        <Heading tag="h3" size="sm" className="mb-4">
          SDK examples
        </Heading>
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
          {/* Tab bar */}
          <div className="flex border-b border-zinc-200 bg-zinc-50">
            {(['python', 'nodejs', 'go'] as const).map((lang) => (
              <button
                key={lang}
                type="button"
                onClick={() => setSdkTab(lang)}
                className={`px-4 py-2.5 text-sm font-medium transition-colors ${
                  sdkTab === lang
                    ? 'border-b-2 border-brand-600 text-brand-700'
                    : 'text-zinc-500 hover:text-zinc-700'
                }`}
              >
                {SDK_META[lang].label}
              </button>
            ))}
          </div>
          {/* Content */}
          <div className="flex flex-col gap-0">
            <div className="border-b border-zinc-100 px-4 py-2.5">
              <span className="text-xs text-zinc-500">Using </span>
              <code className="text-xs font-medium text-zinc-700">
                {active.hint.replace('Using ', '')}
              </code>
            </div>
            <div className="overflow-hidden border-b border-zinc-100">
              <div className="flex items-center gap-3 border-b border-zinc-100 px-4 py-2.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-600">
                  1
                </span>
                <span className="text-sm font-medium text-zinc-800">Install</span>
              </div>
              <div className="px-4 py-3">
                <CodeBlock language="sh" code={active.install} />
              </div>
            </div>
            <div>
              <div className="flex items-center gap-3 border-b border-zinc-100 px-4 py-2.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-600">
                  2
                </span>
                <span className="text-sm font-medium text-zinc-800">Upload &amp; retrieve</span>
              </div>
              <div className="px-4 py-3">
                <CodeBlock language={active.lang} code={active.upload} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Migrating from AWS S3 */}
      <div>
        <Heading tag="h3" size="sm" className="mb-2">
          Migrating from AWS S3
        </Heading>
        <p className="mb-4 text-sm text-zinc-600">
          Fil One is fully S3-compatible. In most cases, you only need to change two settings in
          your existing code.
        </p>
        <div className="overflow-hidden rounded-lg border border-zinc-200">
          <table className="w-full text-sm">
            <tbody>
              {[
                {
                  label: 'Endpoint URL',
                  aws: 'https://s3.amazonaws.com',
                  fil: s3Endpoint,
                  highlight: true,
                },
                {
                  label: 'Credentials',
                  aws: 'AWS IAM key + secret',
                  fil: 'Fil One key + secret',
                  highlight: true,
                },
                { label: 'Region', aws: 'Any AWS region', fil: region, highlight: false },
                {
                  label: 'Path style',
                  aws: 'Optional',
                  fil: 'Required (forcePathStyle: true)',
                  highlight: false,
                },
              ].map((row) => (
                <tr key={row.label} className="border-b border-zinc-100 last:border-0">
                  <td className="w-28 px-4 py-2.5 text-xs font-medium text-zinc-500">
                    {row.label}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-zinc-500 line-through">
                    {row.aws}
                  </td>
                  <td
                    className={`px-4 py-2.5 font-mono text-xs ${row.highlight ? 'rounded bg-brand-50 font-semibold text-brand-700' : 'text-zinc-700'}`}
                  >
                    {row.fil}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="border-t border-zinc-200 bg-zinc-50 px-4 py-2.5 text-xs text-zinc-600">
            ✓ All S3 operations (PUT, GET, DELETE, multipart, presigned URLs) are supported
          </div>
        </div>
      </div>

      {/* Manage buckets */}
      <div className="flex justify-center border-t border-zinc-100 pt-4">
        <a href="/buckets" className="text-sm font-medium text-zinc-500 hover:text-zinc-800">
          Manage buckets →
        </a>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** Minting keys is `keys.create`, which ReadOnly does not hold. */
function CreateKeyAction({ onCreate }: { onCreate: () => void }) {
  return (
    <RequirePermission permission="keys.create">
      <Button
        id="api-keys-create-button"
        variant="ghost"
        size="sm"
        icon={PlusIcon}
        onClick={onCreate}
      >
        Create new key
      </Button>
    </RequirePermission>
  );
}

export function ApiKeysPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const orgSlug = useOrgSlug();
  const queryClient = useQueryClient();
  const mayCreate = useHasPermission('keys.create');
  // Listing is `keys.manage_own` and the server narrows the response to the
  // caller's own keys; `keys.manage_all` lifts that narrowing server-side and
  // asks nothing extra of this request. Revoking is per row.
  const { mayList, mayRevoke } = useKeyActionScope();
  const accountDisabled = useAccountDisabled();

  const openCreateKey = () =>
    void navigate({ to: '/$orgSlug/api-keys/create', params: { orgSlug } });

  const { data, isPending, isError, error } = useQuery({
    queryKey: queryKeys.accessKeys,
    queryFn: () => apiRequest<ListAccessKeysResponse>('/access-keys'),
    staleTime: LIST_STALE_TIME,
    gcTime: LIST_GC_TIME,
    enabled: mayList,
  });
  // Read through the permission, not just `enabled`: react-query keeps serving a
  // disabled query's cached answer, and a mounted page is a live observer, so a
  // mid-session downgrade would leave the key names in the table and the count on
  // the tab above the no-access card.
  const keys = mayList ? (data?.keys ?? []) : [];
  const creatorFor = useKeyCreators(mayList);

  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);

  const deleteKeyMutation = useMutation({
    mutationFn: (id: string) => apiRequest(`/access-keys/${id}`, { method: 'DELETE' }),
    onSuccess: (_, id) => {
      queryClient.setQueryData<ListAccessKeysResponse>(queryKeys.accessKeys, (old) =>
        old ? { keys: old.keys.filter((k) => k.id !== id) } : old,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.accessKeys });
      void queryClient.invalidateQueries({ queryKey: queryKeys.usage });
      toast.success('Access key deleted');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to delete key');
    },
  });

  async function handleDelete(id: string) {
    setConfirmDeleteKey(id);
  }

  async function confirmDeleteKeyAction() {
    if (!confirmDeleteKey) return;
    try {
      await deleteKeyMutation.mutateAsync(confirmDeleteKey);
    } catch {
      // error handled by mutation.onError
    }
  }

  // A disabled account gets the state and nothing else, the way the Buckets page
  // already does it: one Alert, no Create action, no tabs. Every key on this page
  // is refused while the account is disabled, and Connection details documents
  // how to connect with credentials that currently cannot connect. Offering
  // either is offering a way in that is not there. Restoring the account is the
  // only move, and the shell's banner is already pointing at it.
  //
  // Deliberately narrower than `isError`: a transient keys failure keeps the
  // behaviour below, where the panel carries the error and the static
  // Connection details tab beside it survives.
  if (accountDisabled) {
    return (
      <PageLayout
        title="API Keys"
        headingId="api-keys-heading"
        description="Manage credentials and connect via S3-compatible API"
      >
        <Alert
          variant="red"
          description="Your subscription has been canceled. Please reactivate to regain access."
        />
      </PageLayout>
    );
  }

  // The whole page used to be replaced by a spinner or an error card. Both
  // states now live in the keys panel: the Connection details tab is static
  // documentation that works whatever the keys request did, and the action slot
  // is the caller's way out of an empty list.
  return (
    <PageLayout
      title="API Keys"
      headingId="api-keys-heading"
      description="Manage credentials and connect via S3-compatible API"
      action={<CreateKeyAction onCreate={openCreateKey} />}
    >
      <Tabs>
        <TabList>
          <Tab testId="api-keys-tab" count={isPending ? undefined : keys.length}>
            API keys
          </Tab>
          <Tab testId="connection-details-tab">Connection details</Tab>
        </TabList>

        <TabPanels>
          <TabPanel>
            <AccessKeysPanel
              keys={keys}
              mayList={mayList}
              isPending={isPending}
              isError={isError}
              errorMessage={error?.message}
              onCreateOpen={mayCreate ? openCreateKey : undefined}
              onDelete={handleDelete}
              canRevoke={mayRevoke}
              creatorFor={creatorFor}
            />
          </TabPanel>
          <TabPanel>
            <ConnectionDetailsTab />
          </TabPanel>
        </TabPanels>
      </Tabs>

      <ConfirmDialog
        open={confirmDeleteKey !== null}
        onClose={() => setConfirmDeleteKey(null)}
        onConfirm={confirmDeleteKeyAction}
        title="Delete access key"
        description="This access key will be permanently revoked. Any applications using it will lose access immediately."
        confirmLabel="Delete key"
      />
    </PageLayout>
  );
}
