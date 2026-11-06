import { useState } from 'react';
import { CalendarBlankIcon, ClockIcon, FileIcon, TagIcon } from '@phosphor-icons/react/dist/ssr';

import type { S3Region } from '@filone/shared';

import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal';
import { Alert } from './Alert';
import { Button } from './Button';
import { FormField } from './FormField';
import { Select } from './Select';
import { RateComparison, Term, TermList } from './ColdStorageFacts';
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
import { getFolderPrefixes, useCachedListing } from '../lib/use-cached-listing.js';
import { isFilePolicy } from '../lib/cold-storage-files.js';

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
  description: string;
  termTitle: string;
  termBody: string;
  restoreBody: string;
  warning: string;
  confirm: string;
  toast: string;
}

const RESTORE_COPY_BILLING = 'The copy is billed at the standard rate for at least 2 weeks.';

/** The review's words for a bucket or a folder: everything in it, now and later. */
function describeScope(name: string, isBucket: boolean): FreezeCopy {
  return {
    title: `Freeze all files in ${name}`,
    description: `Every file in this ${isBucket ? 'bucket' : 'folder'} freezes at the next daily run. If you upload a new file, it starts at the standard rate and freezes at the next run.`,
    termTitle: `Each file stays frozen for at least ${MIN_TERM_DAYS} days`,
    termBody: `Deleting or replacing a file sooner still bills the rest of its ${MIN_TERM_DAYS} days.`,
    restoreBody: `Restore a file, a folder or the whole bucket. ${RESTORE_COPY_BILLING}`,
    warning: 'Frozen files can’t be downloaded or shared until you restore them.',
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
    description: `${one ? 'It freezes' : 'They freeze'} at the next daily run. Until then, ${one ? 'it works' : 'they work'} as usual.`,
    termTitle: one
      ? `It stays frozen for at least ${MIN_TERM_DAYS} days`
      : `Each stays frozen for at least ${MIN_TERM_DAYS} days`,
    termBody: one
      ? `Deleting or replacing it sooner still bills the rest of its ${MIN_TERM_DAYS} days.`
      : `Deleting or replacing one sooner still bills the rest of its ${MIN_TERM_DAYS} days.`,
    restoreBody: `Restore ${one ? 'it' : 'them'} when you need ${one ? 'it' : 'them'}. ${RESTORE_COPY_BILLING}`,
    warning: one
      ? 'Once frozen, it can’t be downloaded or shared until you restore it.'
      : 'Once frozen, they can’t be downloaded or shared until you restore them.',
    confirm: one ? 'Freeze file' : 'Freeze files',
    toast: `${one ? name : `${keys.length} files`} ${one ? 'freezes' : 'freeze'} at the next daily run.`,
  };
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
  const { versions } = useCachedListing(bucketName, region);
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
  const copy = keys ? describeFiles(keys) : describeScope(isBucket ? bucketName : scope, isBucket);

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
        <div className="flex flex-col gap-5">
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
          {/* A folder or a bucket is a big enough move to set the two rates side
              by side; for picked files the rate is one line among the terms. */}
          {!keys && (
            <RateComparison
              cells={[
                { label: 'Standard', pricePerTbMonth: WARM_PRICE_PER_TB_MONTH },
                { label: 'Frozen', pricePerTbMonth: COLD_PRICE_PER_TB_MONTH },
              ]}
            />
          )}
          <TermList>
            {/* One sentence each, with no rates: both sit in the comparison
                above, so the terms say only what the rates don't. */}
            {keys && (
              <Term
                icon={TagIcon}
                title={`${formatRate(COLD_PRICE_PER_TB_MONTH)} instead of ${formatRate(WARM_PRICE_PER_TB_MONTH)}`}
              >
                {keys.length === 1 ? 'Its' : 'Their'} storage bills at the frozen rate from the next
                daily run.
              </Term>
            )}
            <Term icon={CalendarBlankIcon} title={copy.termTitle}>
              {copy.termBody}
            </Term>
            <Term icon={ClockIcon} title="Restoring takes about an hour">
              {copy.restoreBody}
            </Term>
            {/* Picked files are all 128 KB or more, so the rule only matters
                when freezing a folder or a bucket. */}
            {!keys && (
              <Term icon={FileIcon} title="Files under 128 KB aren’t frozen">
                They stay in standard storage, at the standard rate.
              </Term>
            )}
          </TermList>
          <Alert variant="amber" assertive={false} description={copy.warning} />
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
