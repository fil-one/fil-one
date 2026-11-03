import { ArrowsClockwiseIcon } from '@phosphor-icons/react/dist/ssr';

import {
  formatBytes,
  getRegionLabel,
  getS3Endpoint,
  type RagEngineDatasetInfo,
  type RagEngineIndexInfo,
  type RagEngineStatus,
} from '@filone/shared';

import { FILONE_STAGE } from '../env.js';
import type { RagBucket } from '../lib/rag-bucket-api.js';
import { buildLancePythonSnippet, syncPercent, syncProgressLabel } from '../lib/rag-engine.js';
import { Alert } from './Alert.js';
import { Button } from './Button.js';
import { CodeBlock } from './CodeBlock.js';
import { CopyButton } from './CopyButton.js';
import { ProgressBar } from './ProgressBar.js';
import { RegionFlag } from './RegionFlag.js';

/*
 * Engine-backed (Forge) Bucket Intelligence: the "Index now" strip and the
 * panel describing the Lance dataset the index lives in.
 */

export type RagEngineSyncStripProps = {
  status: RagEngineStatus | undefined;
  /** Whether the caller may start a run (`buckets.create`, like enabling indexing). */
  canSync: boolean;
  onSync: () => void;
  /** True between the click and the engine reporting the run. */
  syncRequested: boolean;
  /**
   * Why the last Index now click or engine read failed, in the API's words.
   * Without it a refused or unreachable engine leaves a button that seems to do
   * nothing.
   */
  error?: string;
};

/**
 * Index now, with live progress while a run is in flight. Runs are idempotent on
 * the engine, so the button only disables while one is already running.
 */
export function RagEngineSyncStrip({
  status,
  canSync,
  onSync,
  syncRequested,
  error,
}: RagEngineSyncStripProps) {
  const syncing = status?.syncState === 'syncing';
  const busy = syncing || syncRequested;
  const percent = syncPercent(status?.progress);

  return (
    <div
      data-testid="rag-engine-sync"
      className="flex flex-shrink-0 flex-col gap-2 border-b border-zinc-100 px-5 py-3"
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 text-xs text-zinc-500">
          <SyncStripLabel status={status} busy={busy} canSync={canSync} />
        </div>
        {canSync && (
          <Button
            data-testid="rag-engine-sync-button"
            variant={status?.lastSyncedAt ? 'ghost' : 'primary'}
            size="sm"
            icon={ArrowsClockwiseIcon}
            disabled={busy}
            loading={syncRequested && !syncing}
            loadingLabel="Starting indexing"
            onClick={onSync}
          >
            {syncing ? 'Indexing' : 'Index now'}
          </Button>
        )}
      </div>
      {busy && (
        <ProgressBar
          size="sm"
          label="Indexing progress"
          value={percent ?? 0}
          indeterminate={percent === undefined}
        />
      )}
      {!busy && <SyncStripErrors status={status} error={error} />}
    </div>
  );
}

function SyncStripLabel({
  status,
  busy,
  canSync,
}: {
  status: RagEngineStatus | undefined;
  busy: boolean;
  canSync: boolean;
}) {
  if (busy) {
    return (
      <span data-testid="rag-engine-sync-progress-label" className="text-zinc-700">
        <span className="font-medium text-zinc-900">Indexing</span>
        {' · '}
        {syncProgressLabel(status?.progress)}
      </span>
    );
  }
  if (status?.lastSyncedAt) return <>New and changed files are picked up on the next run.</>;
  if (canSync) {
    return <>Index now reads every supported file into a Lance dataset on your Forge storage.</>;
  }
  return <>Indexing hasn&apos;t run yet.</>;
}

/** A refused request, then the engine's own record of a failed run. */
function SyncStripErrors({
  status,
  error,
}: {
  status: RagEngineStatus | undefined;
  error: string | undefined;
}) {
  const runError = status?.syncState === 'error' ? status.lastSyncError : undefined;
  return (
    <>
      {error && (
        <div data-testid="rag-engine-request-error">
          <Alert variant="red" description={error} />
        </div>
      )}
      {runError && (
        <div data-testid="rag-engine-sync-error">
          <Alert variant="red" description={runError} />
        </div>
      )}
    </>
  );
}

export type RagDatasetPanelProps = {
  bucket: RagBucket;
  dataset: RagEngineDatasetInfo;
};

/**
 * Where and how the bucket's index is stored: a Lance dataset in a companion
 * bucket on the tenant's own Forge storage, its size, indexes and embedding
 * model, and the Python to open it directly with `lancedb`.
 */
export function RagDatasetPanel({ bucket, dataset }: RagDatasetPanelProps) {
  const vectorIndex = dataset.indexes.find((i) => i.columns.includes('vector'));
  const facts: { label: string; value: string; testId: string }[] = [
    { label: 'Rows', value: dataset.rows.toLocaleString(), testId: 'dataset-rows' },
    { label: 'Objects', value: dataset.objects.toLocaleString(), testId: 'dataset-objects' },
    { label: 'Version', value: `v${dataset.version}`, testId: 'dataset-version' },
    ...(dataset.storageBytes !== undefined
      ? [{ label: 'On storage', value: formatBytes(dataset.storageBytes), testId: 'dataset-size' }]
      : []),
    ...(dataset.fragments !== undefined
      ? [
          {
            label: 'Fragments',
            value: dataset.fragments.toLocaleString(),
            testId: 'dataset-fragments',
          },
        ]
      : []),
    {
      label: 'Embedding',
      value: `${dataset.embedding.dimension} dims`,
      testId: 'dataset-dimension',
    },
  ];

  return (
    <div data-testid="rag-dataset-panel" className="border-t border-zinc-100 px-5 py-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-meta font-medium uppercase tracking-widest text-zinc-500">
          Lance dataset
        </p>
        <span className="flex items-center gap-1.5 text-meta text-zinc-500">
          <RegionFlag region={bucket.region} />
          Forge · {getRegionLabel(bucket.region)}
        </span>
      </div>

      {/* Shown whole rather than truncated: the URI is the point of the panel. */}
      <div className="flex items-start gap-2">
        <code
          data-testid="dataset-uri"
          className="flex-1 rounded-md bg-zinc-100 px-2.5 py-1.5 font-mono text-xs break-all text-zinc-900"
        >
          {dataset.uri}
        </code>
        <CopyButton value={dataset.uri} />
      </div>

      <dl className="mt-4 grid grid-cols-3 gap-x-4 gap-y-3">
        {facts.map((fact) => (
          <div key={fact.label} data-testid={fact.testId}>
            <dt className="text-meta text-zinc-500">{fact.label}</dt>
            <dd className="text-ui font-medium text-zinc-900 tabular-nums">{fact.value}</dd>
          </div>
        ))}
      </dl>
      <p data-testid="dataset-embedding-model" className="mt-3 text-meta text-zinc-500">
        Embedded with <span className="font-mono text-zinc-700">{dataset.embedding.model}</span>
      </p>

      <div className="mt-4">
        <p className="mb-2 text-xs font-medium text-zinc-700">Indexes</p>
        <ul
          data-testid="dataset-indexes"
          className="divide-y divide-zinc-100 rounded-lg border border-zinc-200"
        >
          {!vectorIndex && (
            <IndexRow
              index={{ name: 'vector', type: 'Flat scan', columns: ['vector'] }}
              note="Built as the dataset grows"
            />
          )}
          {dataset.indexes.map((index) => (
            <IndexRow key={index.name} index={index} />
          ))}
        </ul>
      </div>

      <div className="mt-4">
        <p className="mb-2 text-xs font-medium text-zinc-700">Open it with LanceDB</p>
        <CodeBlock
          language="python"
          code={buildLancePythonSnippet({
            companionBucket: dataset.companionBucket,
            table: dataset.table,
            endpoint: getS3Endpoint(bucket.region, FILONE_STAGE),
            region: bucket.region,
          })}
        />
        <p className="mt-2 text-xs text-zinc-500">
          Use an access key with access to all buckets in this region, exported as{' '}
          <code className="font-mono">FILONE_ACCESS_KEY_ID</code> and{' '}
          <code className="font-mono">FILONE_SECRET_ACCESS_KEY</code>.
        </p>
      </div>
    </div>
  );
}

function IndexRow({ index, note }: { index: RagEngineIndexInfo; note?: string }) {
  const coverage =
    index.indexedRows !== undefined
      ? `${index.indexedRows.toLocaleString()} indexed${index.unindexedRows ? ` · ${index.unindexedRows.toLocaleString()} pending` : ''}`
      : undefined;
  return (
    <li data-testid="dataset-index" className="flex items-center gap-3 px-3 py-2 text-xs">
      <span className="inline-flex shrink-0 items-center rounded-full bg-zinc-100 px-2 py-0.5 font-mono text-meta font-medium text-zinc-700">
        {index.type}
      </span>
      <span className="min-w-0 truncate font-mono text-zinc-600">{index.columns.join(', ')}</span>
      <span className="ml-auto shrink-0 text-right text-meta text-zinc-500 tabular-nums">
        {note ?? coverage}
      </span>
    </li>
  );
}
