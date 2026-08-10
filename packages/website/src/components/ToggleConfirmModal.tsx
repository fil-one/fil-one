import { RAG_DOCS_URL } from '../lib/rag-docs.js';
import { Button } from './Button.js';
import { Link } from './Link.js';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal/index.js';

export type ToggleConfirmModalProps = {
  enabled: boolean;
  /** Bucket the toggle applies to, named in the copy so the dialog is unambiguous. */
  bucketName: string;
  pending: boolean;
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
};

/**
 * The facts a user needs before indexing a bucket, as scannable rows rather than
 * prose, so nobody has to read the whole dialog to find the one they care about.
 *
 * "Ready in" is load-bearing: indexing is driven by a 6-hourly cron (see
 * `RagIndexerCron` in sst.config.ts), NOT by uploads, so a bucket is not
 * queryable the moment it is enabled. Earlier copy claimed "new uploads are
 * indexed automatically", which read as instant and set the wrong expectation.
 * The 6-hour figure matches docs.fil.one/bucket-intelligence.
 *
 * "Indexes" prevents the "enabled it, got 0 files indexed" dead end on buckets
 * of images, video, or CSVs. Source of truth for the list:
 * packages/backend/src/jobs/rag-content-type.ts.
 */
const INDEXING_FACTS: { label: string; value: React.ReactNode }[] = [
  {
    label: 'Ready in',
    value: 'Up to 6 hours. Indexing runs on a schedule, not on upload.',
  },
  {
    label: 'Indexes',
    value: (
      <>
        PDF, Word, PowerPoint, Markdown, HTML, plain text. Other files are skipped.{' '}
        {/* Attached to the file-type line because that is where the docs add what
            this dialog cannot: scanned PDFs have no text layer and are skipped
            silently, so a bucket of scans indexes to nothing. */}
        <Link href={RAG_DOCS_URL} variant="accent">
          What gets indexed
        </Link>
      </>
    ),
  },
];

export function ToggleConfirmModal({
  enabled,
  bucketName,
  pending,
  open,
  onClose,
  onConfirm,
}: ToggleConfirmModalProps) {
  return (
    <Modal open={open} onClose={onClose} size="sm" testId="toggle-confirm-modal">
      <ModalHeader
        onClose={onClose}
        description={
          enabled
            ? `“${bucketName}” will stop being indexed and can no longer be queried.`
            : `Files in “${bucketName}” become queryable in the app and through the Query API.`
        }
      >
        {enabled ? 'Stop indexing this bucket?' : 'Index this bucket?'}
      </ModalHeader>
      <ModalBody>
        {enabled ? (
          <p className="text-sm leading-relaxed text-(--color-paragraph-text)">
            Your files and the index built from them are kept, so you can start indexing again at
            any time.
          </p>
        ) : (
          <>
            {/* Hairline-separated rows keep the facts dense and scannable without
                the visual weight of a filled callout box. Colours come from the
                paragraph-text tokens rather than raw zinc shades so the dialog
                follows the light/dark section variants in globals.css, and so the
                label column clears WCAG AA (zinc-400 is only 2.56:1 on white). */}
            <dl className="divide-y divide-(--color-border-muted) border-y border-(--color-border-muted)">
              {INDEXING_FACTS.map((fact) => (
                <div key={fact.label} className="flex gap-4 py-2.5 text-sm leading-relaxed">
                  <dt className="w-20 flex-shrink-0 text-(--color-paragraph-text-subtle)">
                    {fact.label}
                  </dt>
                  <dd className="text-(--color-paragraph-text-strong)">{fact.value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-xs text-(--color-paragraph-text-subtle)">
              You can stop indexing at any time. Nothing is deleted.
            </p>
          </>
        )}
      </ModalBody>
      <ModalFooter fullWidth>
        <Button
          data-testid="toggle-confirm-cancel"
          variant="ghost"
          size="md"
          onClick={onClose}
          disabled={pending}
        >
          Cancel
        </Button>
        <Button
          data-testid="toggle-confirm-submit"
          variant={enabled ? 'destructive' : 'primary'}
          size="md"
          onClick={onConfirm}
          disabled={pending}
        >
          {enabled ? 'Stop indexing' : 'Start indexing'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
