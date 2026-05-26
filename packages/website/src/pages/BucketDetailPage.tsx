import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ArrowUpIcon } from '@phosphor-icons/react/dist/ssr';

import { Heading } from '../components/Heading/Heading';
import { Button } from '../components/Button';
import { Tabs, TabList, Tab, TabPanels, TabPanel } from '../components/Tabs';
import { Breadcrumb } from '../components/Breadcrumb';
import { Alert } from '../components/Alert';
import { Spinner } from '../components/Spinner';
import { AddBucketKeyModal } from '../components/AddBucketKeyModal';
import { BucketPropertyCards } from '../components/BucketPropertiesCard';
import { ObjectBrowser } from '../components/ObjectBrowser';
import { BucketAccessTab } from '../components/BucketAccessTab';
import type { S3Region } from '@filone/shared';
import { getS3Endpoint, S3_REGION, formatBytes } from '@filone/shared';
import { FILONE_STAGE } from '../env';
import { formatDateTime } from '../lib/time.js';
import { useBucketDetail } from '../lib/use-bucket-detail.js';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export type BucketDetailPageProps = {
  bucketName: string;
  prefix?: string;
};

export function BucketDetailPage({ bucketName, prefix }: BucketDetailPageProps) {
  const navigate = useNavigate();
  const currentPrefix = prefix ?? '';
  const s3Endpoint = getS3Endpoint(S3_REGION, FILONE_STAGE);

  const {
    setCurrentPrefix,
    bucket,
    versions,
    analyticsData,
    accessKeys,
    objectsLoading,
    objectsIsError,
    objectsError,
    accessKeysLoading,
    objectActions,
    invalidateAccessKeysCache,
  } = useBucketDetail(bucketName);

  const [addKeyOpen, setAddKeyOpen] = useState(false);

  if (objectsLoading) {
    return (
      <div className="flex items-center justify-center p-16">
        <Spinner ariaLabel="Loading objects" size={32} />
      </div>
    );
  }

  if (objectsIsError) {
    return (
      <div className="px-10 pt-10">
        <Breadcrumb items={[{ label: 'Buckets', href: '/buckets' }, { label: bucketName }]} />
        <div className="mt-4">
          <Alert variant="red" description={objectsError?.message ?? 'Failed to load objects'} />
        </div>
      </div>
    );
  }

  const bucketRegion = (bucket?.region as S3Region | undefined) ?? S3_REGION;

  return (
    <div className="px-10 pt-10">
      <Breadcrumb items={[{ label: 'Buckets', href: '/buckets' }, { label: bucketName }]} />

      <div className="mt-4 mb-2 flex items-center justify-between">
        <Heading tag="h1" size="xl">
          {bucketName}
        </Heading>
        <Button
          variant="primary"
          size="md"
          icon={ArrowUpIcon}
          onClick={() =>
            void navigate({
              to: '/buckets/$bucketName/upload',
              params: { bucketName },
            })
          }
        >
          Upload object
        </Button>
      </div>

      {bucket && (
        <p className="mb-6 text-sm">
          <span className="text-zinc-700">{bucketRegion}</span>
          <span className="mx-2 text-zinc-400">&bull;</span>
          <span className="text-xs text-zinc-500">
            {analyticsData ? formatBytes(analyticsData.bytesUsed) : '—'} used
          </span>
          <span className="mx-2 text-zinc-400">&bull;</span>
          <span className="text-xs text-zinc-500">Created {formatDateTime(bucket.createdAt)}</span>
        </p>
      )}

      {bucket && (
        <div className="mb-6 grid grid-cols-3 gap-4">
          <BucketPropertyCards bucket={bucket} />
        </div>
      )}

      <Tabs>
        <TabList>
          <Tab>Objects{!objectsLoading && ` (${versions.length.toLocaleString()})`}</Tab>
          <Tab>API Keys{!accessKeysLoading && ` (${accessKeys.length.toLocaleString()})`}</Tab>
        </TabList>

        <TabPanels>
          <TabPanel>
            <ObjectBrowser
              bucketName={bucketName}
              versions={versions}
              versioningEnabled={bucket?.versioning ?? false}
              currentPrefix={currentPrefix}
              onPrefixChange={setCurrentPrefix}
              onDownload={objectActions.downloadObject}
              downloading={objectActions.downloading}
              onDelete={objectActions.deleteObject}
            />
          </TabPanel>

          <TabPanel>
            <BucketAccessTab
              bucketName={bucketName}
              s3Endpoint={s3Endpoint}
              region={bucketRegion}
              accessKeys={accessKeys}
              accessKeysLoading={accessKeysLoading}
              onCreateOpen={() => setAddKeyOpen(true)}
            />
          </TabPanel>
        </TabPanels>
      </Tabs>

      <AddBucketKeyModal
        open={addKeyOpen}
        onClose={() => setAddKeyOpen(false)}
        bucketName={bucketName}
        bucketRegion={bucketRegion}
        onKeyAdded={invalidateAccessKeysCache}
      />
    </div>
  );
}
