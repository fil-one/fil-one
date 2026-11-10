import type { S3Region } from '@filone/shared';

import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal';
import { Button } from './Button';
import { FactList } from './ColdStorageFacts';
import { useToast } from './Toast';
import {
  COLD_PRICE_PER_TB_MONTH,
  MIN_TERM_DAYS,
  WARM_PRICE_PER_TB_MONTH,
  formatRate,
  keepInStandard,
  trackColdStorage,
  useLastNonNull,
} from '../lib/cold-storage-prototype.js';

export interface KeepInStandardTarget {
  bucketName: string;
  region: S3Region;
  keys: string[];
  /** How many of `keys` are still inside their minimum term. */
  inTermCount: number;
}

function countFiles(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? 'file' : 'files'}`;
}

/**
 * A permanent restore: the files move to Standard for good and the daily run
 * skips them, new uploads under the same names included, until "Freeze again".
 * Ending a frozen term early bills its remaining days, so the confirmation
 * says so whenever any file is still inside its term.
 */
export function KeepInStandardDialog({
  target,
  onClose,
}: {
  target: KeepInStandardTarget | null;
  onClose: () => void;
}) {
  const shown = useLastNonNull(target);
  const { toast } = useToast();
  if (!shown) return null;
  const one = shown.keys.length === 1;
  const files = countFiles(shown.keys.length);
  const termNote =
    shown.inTermCount === 0
      ? null
      : `${shown.inTermCount === shown.keys.length ? (one ? 'It is' : 'They are') : `${shown.inTermCount} of them are`} inside the ${MIN_TERM_DAYS}-day frozen term, which still bills its remaining days at ${formatRate(COLD_PRICE_PER_TB_MONTH)}.`;

  const { bucketName, region, keys } = shown;
  const handleKeep = () => {
    keepInStandard(bucketName, region, keys);
    trackColdStorage('kept in standard', { files: String(keys.length) });
    toast.success(`${files} back in Standard`);
    onClose();
  };

  return (
    <Modal open={target !== null} onClose={onClose} size="sm" testId="keep-in-standard-dialog">
      <ModalHeader
        onClose={onClose}
        description={
          // One line per sentence, as in the restore dialog.
          <>
            <span className="block">
              {one ? 'The file stays' : 'The files stay'} in Standard for good.
            </span>
            <span className="block">Freeze {one ? 'it' : 'them'} again any time.</span>
          </>
        }
      >
        Keep {files} in Standard?
      </ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-4">
          <FactList
            facts={[
              { label: 'Storage', value: 'Standard', detail: formatRate(WARM_PRICE_PER_TB_MONTH) },
              { label: 'Daily run', value: `Skips ${one ? 'this file' : 'these files'}` },
            ]}
          />
          {termNote && <p className="text-xs text-(--color-paragraph-text-subtle)">{termNote}</p>}
        </div>
      </ModalBody>
      <ModalFooter fullWidth>
        <Button id="keep-in-standard-cancel-button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button id="keep-in-standard-confirm-button" variant="primary" onClick={handleKeep}>
          Keep in Standard
        </Button>
      </ModalFooter>
    </Modal>
  );
}
