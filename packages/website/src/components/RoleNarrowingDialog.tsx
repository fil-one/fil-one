import { KeyIcon } from '@phosphor-icons/react/dist/ssr';
import { formatRegion, type AccessKeySummary } from '@filone/shared';

import { Alert } from './Alert';
import { Button } from './Button';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal';
import { Skeleton } from './Skeleton';

export type RoleNarrowingDialogProps = {
  open: boolean;
  /** Whose keys these are, named as the roster names them. */
  memberName: string;
  /** The caller's own row, which the copy addresses in the second person. */
  self?: boolean;
  fromRole: string;
  toRole: string;
  /** What else the change costs, when the caller is changing their own row. */
  note?: string | undefined;
  /** The preview, or undefined while it loads or after it failed. */
  keys: AccessKeySummary[] | undefined;
  /** Keys of theirs the new role still allows. */
  survivingCount: number;
  /** Keys in this org with no recorded owner, which no role change touches. */
  unattributedCount: number;
  loading?: boolean;
  /** The preview could not be read, so the list is not the whole story. */
  error?: boolean;
  pending?: boolean;
  /** Why the last attempt was refused, shown here rather than behind the modal. */
  refusal?: string | undefined;
  onClose: () => void;
  onConfirm: () => void;
};

/**
 * What a role change takes away, before it happens.
 *
 * An access key carries its own permission set, fixed when it was minted, and
 * nothing at the storage vendor checks it against the role its holder now has.
 * So a narrowing revokes the keys the member could no longer mint, and the
 * client using one stops working with no other warning. This is where an admin
 * sees that, and where the safe order gets stated: create the replacement key
 * first, then change the role.
 *
 * Its own dialog rather than `ConfirmDialog`, whose description is one string.
 */
export function RoleNarrowingDialog({
  open,
  memberName,
  self = false,
  fromRole,
  toRole,
  note,
  keys,
  survivingCount,
  unattributedCount,
  loading = false,
  error = false,
  pending = false,
  refusal,
  onClose,
  onConfirm,
}: RoleNarrowingDialogProps) {
  const keysToRevoke = keys ?? [];
  const subject = self ? 'You go' : `${memberName} goes`;

  return (
    <Modal
      open={open}
      onClose={pending ? () => {} : onClose}
      size="md"
      testId="role-narrowing-dialog"
    >
      <ModalHeader
        onClose={pending ? undefined : onClose}
        description={`${subject} from ${fromRole} to ${toRole}.`}
      >
        {self ? 'Change your own role?' : 'Change this role?'}
      </ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-4">
          {note && <p className="text-ui text-zinc-600">{note}</p>}
          <PreviewBody
            loading={loading}
            error={error}
            self={self}
            keysToRevoke={keysToRevoke}
            survivingCount={survivingCount}
            unattributedCount={unattributedCount}
          />
          {refusal && <Alert variant="red" title="That change was refused" description={refusal} />}
        </div>
      </ModalBody>
      <ModalFooter fullWidth>
        <Button
          id="role-narrowing-cancel-button"
          variant="ghost"
          size="md"
          onClick={onClose}
          disabled={pending}
        >
          Cancel
        </Button>
        <ConfirmButton
          pending={pending}
          loading={loading}
          // A failed preview leaves the list empty while the change still
          // revokes, so an unknown impact is destructive too.
          destructive={keysToRevoke.length > 0 || error}
          onClick={onConfirm}
        />
      </ModalFooter>
    </Modal>
  );
}

function PreviewBody({
  loading,
  error,
  self,
  keysToRevoke,
  survivingCount,
  unattributedCount,
}: {
  loading: boolean;
  error: boolean;
  self: boolean;
  keysToRevoke: AccessKeySummary[];
  survivingCount: number;
  unattributedCount: number;
}) {
  if (loading) return <Skeleton className="h-20 w-full" />;

  if (error) {
    return (
      <Alert
        variant="amber"
        title="The affected keys could not be listed"
        description="The change still revokes every key the new role cannot hold."
        assertive={false}
      />
    );
  }

  if (keysToRevoke.length === 0) {
    return (
      <p className="text-ui text-zinc-600">
        {self ? 'None of your' : 'None of their'} access keys carry more than the new role allows,
        so all of them keep working.
      </p>
    );
  }

  return (
    <>
      <p className="text-ui text-zinc-600">
        {keysToRevoke.length === 1
          ? 'This access key stops working straight away:'
          : `These ${keysToRevoke.length} access keys stop working straight away:`}
      </p>
      <ul className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3">
        {keysToRevoke.map((key) => (
          <AccessKeyRow key={key.id} accessKey={key} />
        ))}
      </ul>
      <Alert
        variant="blue"
        description={`To keep a client running, create a replacement key with the narrower permissions first, then change the role.`}
        assertive={false}
      />
      <Footnote self={self} survivingCount={survivingCount} unattributedCount={unattributedCount} />
    </>
  );
}

function AccessKeyRow({ accessKey }: { accessKey: AccessKeySummary }) {
  const carries = accessKey.excess.length > 0 ? ` · carries ${accessKey.excess.join(', ')}` : '';

  return (
    <li className="flex items-start gap-2">
      <KeyIcon width={16} height={16} className="mt-0.5 shrink-0 text-zinc-400" />
      <span className="flex flex-col">
        <span className="text-ui font-medium text-zinc-900">
          {accessKey.keyName}
          {accessKey.accessKeyIdSuffix && (
            <span className="font-normal text-zinc-500"> …{accessKey.accessKeyIdSuffix}</span>
          )}
        </span>
        <span className="text-xs text-zinc-500">
          {formatRegion(accessKey.region)} · created {accessKey.createdAt.slice(0, 10)}
          {carries}
        </span>
      </span>
    </li>
  );
}

/** What the list above leaves out, so a short list is not read as the whole story. */
function Footnote({
  self,
  survivingCount,
  unattributedCount,
}: {
  self: boolean;
  survivingCount: number;
  unattributedCount: number;
}) {
  const lines: string[] = [];
  if (survivingCount > 0) {
    lines.push(
      `${survivingCount} of ${self ? 'your' : 'their'} other keys stay within the new role and keep working.`,
    );
  }
  // Whole sentences per count: patching verbs one at a time is how "1 key has …
  // and are not affected" happened.
  if (unattributedCount > 0) {
    lines.push(
      unattributedCount === 1
        ? '1 key in this organization has no recorded owner and is not affected.'
        : `${unattributedCount} keys in this organization have no recorded owner and are not affected.`,
    );
  }
  if (lines.length === 0) return null;

  return <p className="text-xs text-zinc-500">{lines.join(' ')}</p>;
}

function ConfirmButton({
  pending,
  loading,
  destructive,
  onClick,
}: {
  pending: boolean;
  loading: boolean;
  destructive: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      id="role-narrowing-confirm-button"
      variant={destructive ? 'destructive' : 'primary'}
      size="md"
      onClick={onClick}
      disabled={pending || loading}
    >
      {pending ? 'Changing...' : destructive ? 'Change role and revoke' : 'Change role'}
    </Button>
  );
}
