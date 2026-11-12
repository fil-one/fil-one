import type { S3Region } from '@filone/shared';

import { Alert } from './Alert';
import {
  COLD_PRICE_PER_TB_MONTH,
  MIN_TERM_DAYS,
  WARM_PRICE_PER_TB_MONTH,
  formatRate,
  isInMinimumTerm,
  useColdFiles,
} from '../lib/cold-storage-prototype.js';
import { findReplacedColdFiles } from '../lib/cold-storage-files.js';
import { useCachedListing } from '../lib/use-cached-listing.js';

/** What happens to the frozen copies an upload replaces. */
function describeOutcome(count: number, versioned: boolean): string {
  if (!versioned) return `Uploading deletes the frozen ${count === 1 ? 'copy' : 'copies'}.`;
  const moves =
    count === 1
      ? 'copy moves to standard storage as an older version'
      : 'copies move to standard storage as older versions';
  return `The frozen ${moves}, at ${formatRate(WARM_PRICE_PER_TB_MONTH)}.`;
}

/** The early charge, when any replaced file is still inside its term. */
function describeTermCharge(inTerm: number, count: number): string {
  if (inTerm === 0) return '';
  const subject = inTerm < count ? `${inTerm} of them are` : count === 1 ? 'It is' : 'They are';
  return ` ${subject} inside the ${MIN_TERM_DAYS}-day term, which still bills its remaining days at ${formatRate(COLD_PRICE_PER_TB_MONTH)}.`;
}

/**
 * Cold storage prototype (FIL-1608): on the upload page, says what replacing
 * frozen files costs before the upload starts. In a versioned bucket each
 * frozen copy moves to standard storage as an older version; in an
 * unversioned one it is deleted. Either way, replacing a file inside its
 * minimum term bills the rest of that term, and a restore still in progress
 * is canceled without charge. The new uploads land in Standard and freeze at
 * the next daily run.
 */
export function FrozenOverwriteNotice({
  bucketName,
  region,
  uploadKeys,
}: {
  bucketName: string;
  region: S3Region;
  uploadKeys: string[];
}) {
  const cold = useColdFiles(bucketName, region);
  const { versions, versioned } = useCachedListing(bucketName, region);
  const replaced =
    cold.record && versions ? findReplacedColdFiles(uploadKeys, versions, cold.getState) : [];
  const inTerm = replaced.filter(({ state }) => isInMinimumTerm(state, cold.now)).length;
  // Replacing in an unversioned bucket after every term has ended costs
  // nothing extra, and deleting the old file is what an overwrite means anyway.
  const costsNothingExtra = !versioned && inTerm === 0;
  if (replaced.length === 0 || costsNothingExtra) return null;

  const title =
    replaced.length === 1
      ? '1 file replaces a frozen copy'
      : `${replaced.length} files replace frozen copies`;

  return (
    <div data-testid="frozen-overwrite-notice">
      <Alert
        variant="amber"
        title={title}
        description={`${describeOutcome(replaced.length, versioned)}${describeTermCharge(inTerm, replaced.length)}`}
        assertive={false}
      />
    </div>
  );
}
