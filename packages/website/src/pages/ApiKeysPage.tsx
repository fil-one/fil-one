import { useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';

import { CopySimpleIcon, PlusIcon } from '@phosphor-icons/react/dist/ssr';

import { AccessKeysTable } from '../components/AccessKeysTable';
import { Button } from '../components/Button';
import { CodeBlock } from '../components/CodeBlock';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Spinner } from '../components/Spinner';
import { Tab, TabList, TabPanel, TabPanels, Tabs } from '../components/Tabs';
import { useToast } from '../components/Toast';

import type { AccessKey, ListAccessKeysResponse } from '@filone/shared';

import { S3_ENDPOINT, S3_REGION } from '@filone/shared';
import { apiRequest } from '../lib/api.js';
import { useCopyToClipboard } from '../lib/use-copy-to-clipboard.js';

// ---------------------------------------------------------------------------
// Tab 1: Access Keys
// ---------------------------------------------------------------------------

type AccessKeysTabProps = {
  keys: AccessKey[];
  onCreateOpen: () => void;
  onDelete: (id: string) => Promise<void>;
};

function AccessKeysTab({ keys, onCreateOpen, onDelete }: AccessKeysTabProps) {
  return (
    <>
      <div className="mt-4 mb-4 flex items-center justify-between">
        <span className="text-sm text-zinc-600">
          {keys.length === 1 ? '1 key' : `${keys.length} keys`}
        </span>
        <Button variant="filled" icon={PlusIcon} onClick={onCreateOpen}>
          Create new key
        </Button>
      </div>

      <AccessKeysTable
        keys={keys}
        showBuckets
        showPermissions
        onDelete={onDelete}
        onCreateOpen={onCreateOpen}
      />
    </>
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

function ConnectionDetailsTab() {
  const [sdkTab, setSdkTab] = useState<'python' | 'nodejs' | 'go'>('python');

  const pythonInstall = `pip install boto3`;
  const pythonUpload = `import boto3

s3 = boto3.client(
    "s3",
    endpoint_url="${S3_ENDPOINT}",
    aws_access_key_id="YOUR_ACCESS_KEY",
    aws_secret_access_key="YOUR_SECRET_KEY",
    region_name="${S3_REGION}",
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
  endpoint: "${S3_ENDPOINT}",
  region: "${S3_REGION}",
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
    config.WithRegion("${S3_REGION}"),
    config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
        "YOUR_ACCESS_KEY", "YOUR_SECRET_KEY", "",
    )),
)

client := s3.NewFromConfig(cfg, func(o *s3.Options) {
    o.BaseEndpoint = aws.String("${S3_ENDPOINT}")
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
      {/* Endpoint + Region card */}
      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <div className="flex items-center border-b border-zinc-100 px-4 py-3">
          <span className="w-28 shrink-0 text-sm text-zinc-500">S3 Endpoint</span>
          <span className="flex-1 font-mono text-sm text-zinc-900">{S3_ENDPOINT}</span>
          <CopyButton value={S3_ENDPOINT} />
        </div>
        <div className="flex items-center px-4 py-3">
          <span className="w-28 shrink-0 text-sm text-zinc-500">Region</span>
          <span className="flex-1 font-mono text-sm text-zinc-900">{S3_REGION}</span>
          <CopyButton value={S3_REGION} />
        </div>
      </div>

      {/* Quickstart CLI */}
      <div>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-900">Quickstart (AWS CLI)</h3>
          <a
            href="https://docs.fil.one"
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
              code: `aws configure set aws_access_key_id YOUR_ACCESS_KEY\naws configure set aws_secret_access_key YOUR_SECRET_KEY\naws configure set default.region ${S3_REGION}`,
            },
            {
              n: 2,
              title: 'Create a bucket',
              code: `aws s3 mb s3://my-bucket --endpoint-url ${S3_ENDPOINT}`,
            },
            {
              n: 3,
              title: 'Upload a file',
              code: `aws s3 cp ./my-file.parquet s3://my-bucket/ --endpoint-url ${S3_ENDPOINT}`,
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
        <h3 className="mb-4 text-sm font-semibold text-zinc-900">SDK examples</h3>
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
        <h3 className="mb-2 text-sm font-semibold text-zinc-900">Migrating from AWS S3</h3>
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
                  fil: S3_ENDPOINT,
                  highlight: true,
                },
                {
                  label: 'Credentials',
                  aws: 'AWS IAM key + secret',
                  fil: 'Fil One key + secret',
                  highlight: true,
                },
                { label: 'Region', aws: 'Any AWS region', fil: S3_REGION, highlight: false },
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
        <Link to="/buckets" className="text-sm font-medium text-zinc-500 hover:text-zinc-800">
          Manage buckets →
        </Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ApiKeysPage() {
  const { toast } = useToast();
  const navigate = useNavigate();

  const [keys, setKeys] = useState<AccessKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchKeys() {
      try {
        const data = await apiRequest<ListAccessKeysResponse>('/access-keys');
        if (!cancelled) {
          setKeys(data.keys);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load access keys');
          setLoading(false);
        }
      }
    }
    void fetchKeys();
    return () => {
      cancelled = true;
    };
  }, []);

  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);

  async function handleDelete(id: string) {
    setConfirmDeleteKey(id);
  }

  async function confirmDeleteKeyAction() {
    if (!confirmDeleteKey) return;
    const id = confirmDeleteKey;
    try {
      await apiRequest(`/access-keys/${id}`, { method: 'DELETE' });
      setKeys((prev) => prev.filter((k) => k.id !== id));
      toast.success('Access key deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete key');
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-16">
        <Spinner ariaLabel="Loading access keys" size={32} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <h1 className="mb-1 text-2xl font-semibold text-zinc-900">API Keys</h1>
      <p className="mb-6 text-sm text-zinc-500">
        Manage credentials and connect via S3-compatible API
      </p>

      <Tabs>
        <TabList>
          <Tab>API keys {keys.length > 0 && `(${keys.length})`}</Tab>
          <Tab>Connection details</Tab>
        </TabList>

        <TabPanels>
          <TabPanel>
            <AccessKeysTab
              keys={keys}
              onCreateOpen={() => void navigate({ to: '/api-keys/create' })}
              onDelete={handleDelete}
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
    </div>
  );
}
