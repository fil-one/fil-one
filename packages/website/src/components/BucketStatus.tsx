import {
  bucketDisplayState,
  bucketDotClass,
  type BucketDisplayState,
  type RagBucket,
} from '../lib/rag-bucket-api.js';

/**
 * A bucket's status as a coloured dot plus a neutral label, sitting at the head of
 * the row's metadata line.
 *
 * Deliberately not a filled pill. A pill is heavy chrome that made status the
 * loudest thing in an otherwise quiet row, and colouring both a dot and the label
 * turned a waiting bucket into a block of amber. Only the dot carries colour, so
 * state stays scannable down a list without shouting, and the title line is left
 * to the bucket name alone.
 */
const STATUS: Record<BucketDisplayState, { label: string; pulse: boolean }> = {
  'not-indexed': { label: 'Not indexed', pulse: false },
  'awaiting-first-index': { label: 'Indexing', pulse: true },
  syncing: { label: 'Indexing', pulse: true },
  error: { label: 'Failed', pulse: false },
  synced: { label: 'Ready', pulse: false },
};

export function BucketStatus({ bucket }: { bucket: RagBucket }) {
  const state = bucketDisplayState(bucket);
  const { label, pulse } = STATUS[state];

  return (
    <span
      data-testid="bucket-status"
      data-sync-state={state}
      className="inline-flex flex-shrink-0 items-center gap-1.5"
    >
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${bucketDotClass(state)} ${pulse ? 'animate-pulse' : ''}`}
      />
      <span className="font-medium text-zinc-600">{label}</span>
    </span>
  );
}
