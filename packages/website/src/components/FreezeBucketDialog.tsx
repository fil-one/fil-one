import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import type { S3Region } from '@filone/shared';

import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal';
import { Button } from './Button';
import { FormField } from './FormField';
import { Select } from './Select';
import { FactList } from './ColdStorageFacts';
import { useToast } from './Toast';
import {
  COLD_PRICE_PER_TB_MONTH,
  MIN_TERM_DAYS,
  WARM_PRICE_PER_TB_MONTH,
  addFileFreezePolicies,
  addFreezePolicy,
  formatRate,
  trackColdStorage,
  useColdFiles,
  useLastNonNull,
} from '../lib/cold-storage-prototype.js';
import { getBucketListing } from '../lib/object-listing.js';
import { getFolderPrefixes, useCachedListing } from '../lib/use-cached-listing.js';
import { countFilesTooSmallToFreeze, isFilePolicy } from '../lib/cold-storage-files.js';

export type ColdStorageTarget = {
  bucketName: string;
  region: S3Region;
  /** The folder to start from, when the dialog opens inside one; else the whole bucket. */
  prefix?: string;
  /** Freezes just these files instead, with no choice of folder. */
  keys?: string[];
};

type FreezeBucketDialogProps = {
  /** The bucket to freeze in; `null` closes the dialog. */
  target: ColdStorageTarget | null;
  onClose: () => void;
};

const WHOLE_BUCKET = '';

interface FreezeCopy {
  title: string;
  /** What stops working, first thing under the title: it changes how these files can be used. */
  description: string;
  freezes: string;
  term: string;
  /** What the lower rate commits to, below the facts as the restore dialog sets its billing. */
  footnote: string;
  confirm: string;
  toast: string;
}

const RESTORE_BILLING = `A restored copy bills at ${formatRate(WARM_PRICE_PER_TB_MONTH)} for at least 2 weeks.`;

/** The review's words for a bucket or a folder: everything in it, now and later. */
function describeScope(name: string): FreezeCopy {
  return {
    title: `Freeze all files in ${name}`,
    description: 'Frozen files can’t be downloaded or shared until you restore them.',
    freezes: 'At the next daily run, new uploads included',
    term: `${MIN_TERM_DAYS} days per file`,
    footnote: `Deleting or replacing a file within ${MIN_TERM_DAYS} days bills the rest of its term. ${RESTORE_BILLING}`,
    confirm: 'Freeze all files',
    toast: `Files in ${name} freeze at the next daily run.`,
  };
}

/** The review's words for picked files: just those. */
function describeFiles(keys: string[]): FreezeCopy {
  const one = keys.length === 1;
  const name = one ? (keys[0].split('/').at(-1) ?? keys[0]) : `${keys.length} files`;
  return {
    title: `Freeze ${name}`,
    description: one
      ? 'Once frozen, it can’t be downloaded or shared until you restore it.'
      : 'Once frozen, they can’t be downloaded or shared until you restore them.',
    freezes: 'At the next daily run',
    term: one ? `${MIN_TERM_DAYS} days` : `${MIN_TERM_DAYS} days per file`,
    footnote: `Deleting or replacing ${one ? 'it' : 'one'} within ${MIN_TERM_DAYS} days bills the rest of its term. ${RESTORE_BILLING}`,
    confirm: one ? 'Freeze file' : 'Freeze files',
    toast: `${name} ${one ? 'freezes' : 'freeze'} at the next daily run.`,
  };
}

/** The small files left in Standard: how many when the listing says, the rule alone when it can't (`null`). */
function describeSmallFiles(count: number | null): string {
  if (count === null) return 'Files under 128 KB';
  return `${count === 1 ? '1 file' : `${count.toLocaleString('en-US')} files`} under 128 KB`;
}

/**
 * The review before freezing: what to freeze, the per-TB rate now and frozen,
 * the terms that come with the lower price, and what stops working. Freezing
 * is a policy, so nothing freezes on confirm: files freeze at the next daily
 * run, and files added later at the run after they arrive.
 */
export function FreezeBucketDialog({ target, onClose }: FreezeBucketDialogProps) {
  const shown = useLastNonNull(target);
  return (
    <Modal open={target !== null} onClose={onClose} size="md" testId="freeze-bucket-dialog">
      {shown && (
        // Keyed so each opening starts from its own target's folder.
        <FreezeForm
          key={`${shown.bucketName}:${shown.prefix ?? ''}:${shown.keys?.join() ?? ''}`}
          target={shown}
          onClose={onClose}
        />
      )}
    </Modal>
  );
}

function FreezeForm({ target, onClose }: { target: ColdStorageTarget; onClose: () => void }) {
  const { bucketName, region } = target;
  const { versions, isComplete } = useCachedListing(bucketName, region);
  const queryClient = useQueryClient();
  // Opened from the Buckets table, nothing has listed the bucket yet. Loading
  // it fills the cache `useCachedListing` reads, so the folders and the
  // small-file count appear once it lands; if it fails, the rule alone shows.
  const isListed = versions !== undefined;
  useEffect(() => {
    if (!isListed) getBucketListing(queryClient, bucketName, region).catch(() => {});
  }, [isListed, queryClient, bucketName, region]);
  const { record } = useColdFiles(bucketName, region);
  const covered = (prefix: string) =>
    record?.policies.some((policy) => !isFilePolicy(policy) && prefix.startsWith(policy.prefix)) ??
    false;
  const folders = getFolderPrefixes(versions ?? []).filter((prefix) => !covered(prefix));
  const [scope, setScope] = useState(
    target.prefix && folders.includes(target.prefix) ? target.prefix : WHOLE_BUCKET,
  );
  const { toast } = useToast();
  const isBucket = scope === WHOLE_BUCKET;
  const keys = target.keys;
  const copy = keys ? describeFiles(keys) : describeScope(isBucket ? bucketName : scope);
  // A count from part of the bucket would understate it, so without the full
  // listing the dialog states the rule instead.
  const smallFileCount =
    versions && isComplete ? countFilesTooSmallToFreeze(versions, scope) : null;

  function handleFreeze() {
    if (keys) addFileFreezePolicies(bucketName, region, keys);
    else addFreezePolicy(bucketName, region, scope);
    trackColdStorage('freeze confirmed', {
      scope: keys ? 'files' : isBucket ? 'bucket' : 'folder',
    });
    toast.success(copy.toast);
    onClose();
  }

  return (
    <>
      <ModalHeader
        onClose={onClose}
        // The bucket itself never freezes: its files do, so uploads keep working
        // and every new file joins the freeze at the run after it arrives.
        description={copy.description}
      >
        {copy.title}
      </ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-4">
          {!keys && folders.length > 0 && (
            <FormField label="What to freeze" htmlFor="freeze-scope">
              <Select id="freeze-scope" value={scope} onChange={setScope}>
                <option value={WHOLE_BUCKET}>The whole bucket</option>
                {folders.map((prefix) => (
                  <option key={prefix} value={prefix}>
                    {prefix}
                  </option>
                ))}
              </Select>
            </FormField>
          )}
          {/* The restore dialog's fact list, so freezing and restoring read as
              one flow. The small files sit under the rate, since they are the
              ones that don't get it. Picked files are all 128 KB or more, so
              that row shows only for a folder or a bucket with small files. */}
          <FactList
            facts={[
              {
                label: 'Frozen rate',
                value: formatRate(COLD_PRICE_PER_TB_MONTH),
                detail: `Instead of ${formatRate(WARM_PRICE_PER_TB_MONTH)}`,
              },
              ...(!keys && smallFileCount !== 0
                ? [
                    {
                      label: 'Not frozen',
                      value: describeSmallFiles(smallFileCount),
                      detail: 'Billed at the standard rate',
                    },
                  ]
                : []),
              { label: 'Freezes', value: copy.freezes },
              { label: 'Minimum term', value: copy.term },
              {
                label: 'Restore time',
                value: 'About an hour',
                detail: 'Before a frozen file can be downloaded again',
              },
            ]}
          />
          <p className="text-xs text-(--color-paragraph-text-subtle)">{copy.footnote}</p>
        </div>
      </ModalBody>
      <ModalFooter fullWidth>
        <Button id="freeze-bucket-cancel-button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button id="freeze-bucket-confirm-button" variant="primary" onClick={handleFreeze}>
          {copy.confirm}
        </Button>
      </ModalFooter>
    </>
  );
}
