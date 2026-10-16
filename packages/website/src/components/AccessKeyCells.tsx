import { ArrowsClockwiseIcon, TrashIcon } from '@phosphor-icons/react/dist/ssr';
import { Fragment } from 'react';

import type { AccessKey, ServiceAccessKey } from '@filone/shared';
import { isBucketInfoPermission, isBucketPermission } from '@filone/shared';

import { Badge } from './Badge';
import type { RowAction } from './RowActionsMenu';
import { Tooltip } from './Tooltip';
import { PERMISSION_OPTIONS } from '../lib/access-key-permission-options.js';

/**
 * Active or Expired. The date an expired key stopped working is in the details
 * drawer: in the table it made that row taller than the rest, and an expired
 * key needs the same decision whenever it expired.
 */
export function KeyStatus({ accessKey }: { accessKey: AccessKey }) {
  return accessKey.status === 'active' ? (
    <Badge color="green" dot size="sm" weight="medium">
      Active
    </Badge>
  ) : (
    <Badge color="grey" dot size="sm" weight="medium">
      Expired
    </Badge>
  );
}

const KEY_TYPE_LABELS: Record<AccessKey['type'], string> = {
  principal: 'Personal',
  service: 'Service',
};

// The create form's own wording for each choice, so the table explains a key
// type the same way the form did when the key was made.
const KEY_TYPE_DESCRIPTIONS: Record<AccessKey['type'], string> = {
  principal: "Acts as its owner. Each bucket's policy decides what it can reach.",
  service: 'Carries its own permissions and buckets. Bucket policies do not apply.',
};

// The explanatory tooltips in this table are hover-only. As tab stops they
// added three to every personal key's row, each repeating the same words; a
// keyboard reaches the same explanations in the key's details drawer, through
// the name button that opens it.
export function KeyTypeBadge({ type }: { type: AccessKey['type'] }) {
  return (
    <Tooltip content={KEY_TYPE_DESCRIPTIONS[type]} side="bottom">
      <Badge color="grey" size="sm" data-key-type={type}>
        {KEY_TYPE_LABELS[type]}
      </Badge>
    </Tooltip>
  );
}

/**
 * The object permissions as plain, static facts, scannable across many rows
 * at once, nothing to click, nothing to guess about. Whatever else the key
 * carries (data-protection extras, bucket management, bucket info) is real
 * detail that a chip has no room to be honest about, so one "+N" opens the
 * drawer instead of trying to cram it in here too.
 */
export function PermissionBadges({
  accessKey,
  onShowDetails,
}: {
  accessKey: ServiceAccessKey;
  onShowDetails: () => void;
}) {
  // PERMISSION_OPTIONS' order, not the array's: same reason the drawer uses
  // it: Read/Write/List/Delete read in a fixed order everywhere else.
  const permissions = accessKey.permissions ?? [];
  const objectPermissions = PERMISSION_OPTIONS.filter((o) => permissions.includes(o.value));
  const bucketManagement = permissions.filter(isBucketPermission);
  const bucketInfo = permissions.filter(isBucketInfoPermission);
  const extraCount =
    (accessKey.granularPermissions?.length ?? 0) + bucketManagement.length + bucketInfo.length;

  return (
    // From `xl`, wide enough for Read, Write, List and Delete side by side.
    // Without a floor the table squeezed this column until each badge took its
    // own line, and the row grew to match. Below `xl` the other columns need the
    // room, and a taller row beats scrolling the table sideways.
    <div className="flex flex-wrap items-center gap-1 xl:min-w-50">
      {objectPermissions.map((option) => (
        <Badge
          key={option.value}
          color="blue"
          size="sm"
          data-testid={`permission-badge-${option.value}`}
        >
          {option.label}
        </Badge>
      ))}
      {extraCount > 0 && (
        // A count, not a pill: as a grey badge it read as one more permission.
        // It matches the Buckets column's "+N", and stays a button so a
        // keyboard can open the drawer from here as well as from the name.
        <button
          type="button"
          data-testid="permission-badge-details"
          onClick={onShowDetails}
          aria-label={`Show all ${extraCount + objectPermissions.length} permissions`}
          className="cursor-pointer rounded-md px-0.5 text-xs text-zinc-500 hover:text-zinc-900 focus-visible:brand-outline"
        >
          +{extraCount}
        </button>
      )}
    </div>
  );
}

const BUCKET_NAMES_INLINE_MAX = 2;

/**
 * Which buckets a key reaches, as text rather than badges. A bucket name is a
 * value to read, while "All buckets" and "Per bucket policy" describe a scope;
 * in the same grey pill the scope read as a bucket of that name. Names take the
 * primary text colour and scopes the muted one, and the drawer lists every
 * bucket in full.
 */
export function BucketSummary({ accessKey }: { accessKey: AccessKey }) {
  if (accessKey.type === 'principal') {
    return (
      <Tooltip content="Buckets whose policy grants this key's owner access." side="bottom">
        <span className="text-xs text-zinc-500 underline decoration-zinc-400 decoration-dotted underline-offset-2 cursor-help">
          Per bucket policy
        </span>
      </Tooltip>
    );
  }
  if (accessKey.bucketScope === 'all') {
    return <span className="text-xs text-zinc-500">All buckets</span>;
  }

  const buckets = accessKey.buckets ?? [];
  if (buckets.length === 0) return <span className="text-xs text-zinc-400">None</span>;

  const shown = buckets.slice(0, BUCKET_NAMES_INLINE_MAX);
  const rest = buckets.length - shown.length;
  return (
    <p
      data-testid="bucket-summary"
      title={buckets.join(', ')}
      className="flex max-w-56 items-baseline gap-1 text-xs text-zinc-900"
    >
      {/* Each name truncates on its own, so a long first name cannot push the
          second out of sight while "+N" counts only the ones after it. Only the
          first shrinks with the column; the second keeps its width up to a cap,
          so a short name stays whole beside a long one. */}
      {shown.map((bucket, index) => (
        <Fragment key={bucket}>
          <span className={index === 0 ? 'min-w-0 truncate' : 'max-w-28 shrink-0 truncate'}>
            {bucket}
          </span>
          {/* Outside the name, so truncating the name never cuts the comma. */}
          {index < shown.length - 1 && <span className="-ml-1 shrink-0">,</span>}
        </Fragment>
      ))}
      {rest > 0 && <span className="shrink-0 text-zinc-500">+{rest}</span>}
    </p>
  );
}

/**
 * A principal key's permissions: a scope described in muted text, like the
 * Buckets column's. The dotted underline and help cursor say a definition waits
 * on hover, the convention for a term explained in place.
 */
export function FollowsBucketPolicy() {
  return (
    <Tooltip content="This key inherits the policy of every bucket it touches." side="bottom">
      <span
        data-testid="permission-badge-follows-bucket-policy"
        className="text-xs text-zinc-500 underline decoration-zinc-400 decoration-dotted underline-offset-2 cursor-help"
      >
        Follows bucket policy
      </span>
    </Tooltip>
  );
}

/**
 * A key's Rotate and Delete as menu items, for the row's menu and the drawer's,
 * so the two offer the same actions in the same order and words. A handler the
 * caller left out means the action is not on offer.
 */
export function keyMenuActions({
  onRotate,
  onDelete,
}: {
  onRotate?: () => void;
  onDelete?: () => void;
}): RowAction[] {
  const actions: RowAction[] = [];
  if (onRotate) actions.push({ label: 'Rotate', icon: ArrowsClockwiseIcon, onSelect: onRotate });
  if (onDelete) {
    actions.push({ label: 'Delete', icon: TrashIcon, onSelect: onDelete, destructive: true });
  }
  return actions;
}
