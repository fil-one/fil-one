import type { S3Region } from '@filone/shared';

import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal';
import { Button } from './Button';
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
  const files = countFiles(shown.keys.length);
  const termNote =
    shown.inTermCount > 0
      ? ` ${shown.inTermCount === shown.keys.length ? (shown.keys.length === 1 ? 'It is' : 'They are') : `${shown.inTermCount} of them are`} inside the ${MIN_TERM_DAYS}-day term, which still bills its remaining days at ${formatRate(COLD_PRICE_PER_TB_MONTH)}.`
      : '';

  const { bucketName, region, keys } = shown;
  const handleKeep = () => {
    keepInStandard(bucketName, region, keys);
    trackColdStorage('kept in standard', { files: String(keys.length) });
    toast.success(`${files} unfrozen`);
    onClose();
  };

  return (
    <Modal open={target !== null} onClose={onClose} size="sm" testId="keep-in-standard-dialog">
      <ModalHeader onClose={onClose}>Unfreeze {files}?</ModalHeader>
      <ModalBody>
        <p className="text-sm leading-relaxed text-(--color-paragraph-text)">
          {shown.keys.length === 1
            ? `The file moves back to standard storage for good, at ${formatRate(WARM_PRICE_PER_TB_MONTH)}, and the daily run stops freezing it. You can freeze it again at any time.${termNote}`
            : `The files move back to standard storage for good, at ${formatRate(WARM_PRICE_PER_TB_MONTH)}, and the daily run stops freezing them. You can freeze them again at any time.${termNote}`}
        </p>
      </ModalBody>
      <ModalFooter fullWidth>
        <Button id="keep-in-standard-cancel-button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button id="keep-in-standard-confirm-button" variant="primary" onClick={handleKeep}>
          Unfreeze
        </Button>
      </ModalFooter>
    </Modal>
  );
}
