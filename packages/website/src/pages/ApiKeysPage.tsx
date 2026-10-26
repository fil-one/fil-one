import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';

import { DatabaseIcon, MagnifyingGlassIcon, PlusIcon } from '@phosphor-icons/react/dist/ssr';

import { AccessKeysTable } from '../components/AccessKeysTable';
import { AccessKeysToolbar } from '../components/AccessKeysToolbar';
import { ConnectionDetailsTab } from './ConnectionDetailsTab';
import { Alert } from '../components/Alert';
import { Button } from '../components/Button';
import { PageLayout } from '../components/PageLayout.js';
import { EmptyStateCard } from '../components/EmptyStateCard';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Tab, TabList, TabPanel, TabPanels, Tabs } from '../components/Tabs';
import { SaveCredentialsModal } from '../components/SaveCredentialsModal';
import { TableSkeleton, type SkeletonColumn } from '../components/Table/TableSkeleton';

import type { AccessKey, ListAccessKeysResponse } from '@filone/shared';

import {
  EMPTY_ACCESS_KEY_FILTERS,
  accessKeyRegions,
  clearHiddenAccessKeyFilters,
  filterAccessKeys,
  shouldShowAccessKeyControls,
} from '../lib/access-key-table.js';
import { apiRequest } from '../lib/api.js';
import { useKeyCreators } from '../lib/use-key-creators.js';
import { LIST_GC_TIME, LIST_STALE_TIME, queryKeys } from '../lib/query-client.js';
import { RequirePermission } from '../components/RequirePermission';
import { useHasPermission } from '../lib/use-permissions.js';
import { useKeyDeletion } from '../lib/use-key-deletion.js';
import { useKeyRotation } from '../lib/use-key-rotation.js';
import { useKeyActionScope } from '../lib/use-key-scope.js';
import { useAccountDisabled } from '../lib/use-account-disabled.js';

// ---------------------------------------------------------------------------
// Tab 1: Access Keys
// ---------------------------------------------------------------------------

// Mirrors AccessKeysTable at its widest (showRegion + showBuckets +
// showPermissions), matching each column's breakpoint so the loading
// placeholder hides the same columns as the real table.
const SKELETON_COLUMNS: SkeletonColumn[] = [
  { label: 'Name' },
  { label: 'Region', className: 'hidden md:table-cell' },
  { label: 'Buckets', className: 'hidden lg:table-cell' },
  { label: 'Permissions', className: 'hidden md:table-cell' },
  { label: 'Status', className: 'hidden sm:table-cell' },
  {},
];

type AccessKeysTabProps = {
  keys: AccessKey[];
  /** Whether `keys` holds only the caller's own keys, which the empty state says. */
  listsOwnKeysOnly?: boolean;
  /** Absent for a role that cannot mint keys — the table drops the control. */
  onCreateOpen?: () => void;
  /** Absent for a role that cannot revoke them — the table drops the column. */
  onDelete?: (id: string) => Promise<void>;
  onBulkDelete?: (ids: string[]) => Promise<void>;
  /** Whether a row's Revoke belongs to this caller. */
  canRevoke?: (key: AccessKey) => boolean;
  /** Absent for a role that cannot mint keys — the table drops the action. */
  onRotate?: (id: string) => void;
  /** Whether this caller could still mint the key, and so may reissue it. */
  canRotate?: (key: AccessKey) => boolean;
  creatorFor?: (userId: string) => { name: string; email?: string } | undefined;
};

function AccessKeysTab({
  keys,
  listsOwnKeysOnly,
  onCreateOpen,
  onDelete,
  onBulkDelete,
  canRevoke,
  onRotate,
  canRotate,
  creatorFor,
}: AccessKeysTabProps) {
  const [filters, setFilters] = useState(EMPTY_ACCESS_KEY_FILTERS);
  const regions = useMemo(() => accessKeyRegions(keys), [keys]);
  const showControls = shouldShowAccessKeyControls(keys.length);
  // The list only ever follows the controls on screen. Below the threshold
  // there are no controls, so nothing narrows it; above it, a filter the
  // toolbar hides (the last expired key deleted, say) stops narrowing it.
  const appliedFilters = clearHiddenAccessKeyFilters(keys, filters);
  const shownKeys = showControls ? filterAccessKeys(keys, appliedFilters) : keys;
  // A hidden filter is cleared, not just ignored, so it cannot come back set
  // when its control reappears (a new personal key after the last was deleted).
  const hiddenFilterIsSet =
    appliedFilters.region !== filters.region ||
    appliedFilters.status !== filters.status ||
    appliedFilters.type !== filters.type;
  useEffect(() => {
    if (hiddenFilterIsSet) setFilters((current) => clearHiddenAccessKeyFilters(keys, current));
  }, [hiddenFilterIsSet, keys]);

  return (
    <>
      {showControls && (
        <AccessKeysToolbar
          filters={appliedFilters}
          onChange={setFilters}
          keys={keys}
          regions={regions}
          matchCount={shownKeys.length}
        />
      )}
      {keys.length > 0 && shownKeys.length === 0 ? (
        <EmptyStateCard
          icon={MagnifyingGlassIcon}
          iconColor="grey"
          title="No matching keys"
          description="No key matches your search and filters."
        >
          <Button
            id="access-keys-clear-filters-button"
            variant="ghost"
            onClick={() => setFilters(EMPTY_ACCESS_KEY_FILTERS)}
          >
            Clear filters
          </Button>
        </EmptyStateCard>
      ) : (
        <AccessKeysTable
          keys={shownKeys}
          allKeys={keys}
          showRegion
          showBuckets
          showPermissions
          linkBuckets
          onDelete={onDelete}
          onBulkDelete={onBulkDelete}
          canDelete={canRevoke}
          onRotate={onRotate}
          canRotate={canRotate}
          creatorFor={creatorFor}
          onCreateOpen={onCreateOpen}
          // The org may hold keys this caller is not shown. Without this, a new
          // Member reads an empty list as the org's keys having gone missing.
          {...(listsOwnKeysOnly && {
            emptyDescription:
              'You can only see the keys you create. Owners and Admins see every key in the organization.',
          })}
        />
      )}
      {keys.length === 0 && (
        <div className="mt-6 flex justify-center">
          <Button variant="tertiary" icon={DatabaseIcon} href="/buckets">
            Manage buckets
          </Button>
        </div>
      )}
    </>
  );
}

/**
 * The keys tab in each of its four states.
 *
 * All four live inside the tab rather than replacing the page, so the static
 * Connection details tab beside it survives a failed or refused keys request.
 */
function AccessKeysPanel({
  keys,
  listsOwnKeysOnly,
  mayList,
  isPending,
  isError,
  errorMessage,
  onCreateOpen,
  onDelete,
  onBulkDelete,
  canRevoke,
  onRotate,
  canRotate,
  creatorFor,
}: AccessKeysTabProps & {
  mayList: boolean;
  isPending: boolean;
  isError: boolean;
  errorMessage?: string;
}) {
  if (!mayList) {
    return (
      <div
        data-testid="api-keys-no-access"
        className="mt-4 rounded-lg border border-zinc-200 bg-white p-6 text-sm text-zinc-600"
      >
        Access keys are managed by members who can create them. Your role can browse buckets and
        objects; the connection details are in the next tab.
      </div>
    );
  }

  if (isPending) {
    return (
      <div className="mt-4">
        <TableSkeleton columns={SKELETON_COLUMNS} rows={4} aria-label="Loading access keys" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="mt-4">
        <Alert variant="red" description={errorMessage ?? 'Failed to load access keys'} />
      </div>
    );
  }

  return (
    <AccessKeysTab
      keys={keys}
      listsOwnKeysOnly={listsOwnKeysOnly}
      onCreateOpen={onCreateOpen}
      onDelete={onDelete}
      onBulkDelete={onBulkDelete}
      canRevoke={canRevoke}
      onRotate={onRotate}
      canRotate={canRotate}
      creatorFor={creatorFor}
    />
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** Minting keys is `keys.create`, which ReadOnly does not hold. */
function CreateKeyAction({ onCreate }: { onCreate: () => void }) {
  return (
    <RequirePermission permission="keys.create">
      <Button
        id="api-keys-create-button"
        variant="ghost"
        size="sm"
        icon={PlusIcon}
        onClick={onCreate}
      >
        Create new key
      </Button>
    </RequirePermission>
  );
}

export function ApiKeysPage() {
  const navigate = useNavigate();
  const mayCreate = useHasPermission('keys.create');
  const rotation = useKeyRotation();
  const deletion = useKeyDeletion();
  // Listing is `keys.manage_own` and the server narrows the response to the
  // caller's own keys; `keys.manage_all` lifts that narrowing server-side and
  // asks nothing extra of this request. Revoking is per row.
  const { mayList, listsOwnKeysOnly, mayRevoke } = useKeyActionScope();
  const accountDisabled = useAccountDisabled();

  const openCreateKey = () => void navigate({ to: '/api-keys/create' });

  const { data, isPending, isError, error } = useQuery({
    queryKey: queryKeys.accessKeys,
    queryFn: () => apiRequest<ListAccessKeysResponse>('/access-keys'),
    staleTime: LIST_STALE_TIME,
    gcTime: LIST_GC_TIME,
    enabled: mayList,
  });
  // Read through the permission, not just `enabled`: react-query keeps serving a
  // disabled query's cached answer, and a mounted page is a live observer, so a
  // mid-session downgrade would leave the key names in the table and the count on
  // the tab above the no-access card.
  const keys = mayList ? (data?.keys ?? []) : [];
  const creatorFor = useKeyCreators(mayList);

  const [tabIndex, setTabIndex] = useState(0);

  // A disabled account gets the state and nothing else, the way the Buckets page
  // already does it: one Alert, no Create action, no tabs. Every key on this page
  // is refused while the account is disabled, and Connection details documents
  // how to connect with credentials that currently cannot connect. Offering
  // either is offering a way in that is not there. Restoring the account is the
  // only move, and the shell's banner is already pointing at it.
  //
  // Deliberately narrower than `isError`: a transient keys failure keeps the
  // behaviour below, where the panel carries the error and the static
  // Connection details tab beside it survives.
  if (accountDisabled) {
    return (
      <PageLayout
        title="API Keys"
        headingId="api-keys-heading"
        description="Manage credentials and connect via S3-compatible API"
      >
        <Alert
          variant="red"
          description="Your subscription has been canceled. Please reactivate to regain access."
        />
      </PageLayout>
    );
  }

  // The whole page used to be replaced by a spinner or an error card. Both
  // states now live in the keys panel: the Connection details tab is static
  // documentation that works whatever the keys request did, and the action slot
  // is the caller's way out of an empty list.
  return (
    <PageLayout
      title="API Keys"
      headingId="api-keys-heading"
      description="Manage credentials and connect via S3-compatible API"
      action={<CreateKeyAction onCreate={openCreateKey} />}
    >
      <Tabs selectedIndex={tabIndex} onChange={setTabIndex}>
        <TabList>
          <Tab testId="api-keys-tab" count={isPending ? undefined : keys.length}>
            API keys
          </Tab>
          <Tab testId="connection-details-tab">Connection details</Tab>
        </TabList>

        <TabPanels>
          <TabPanel>
            <AccessKeysPanel
              keys={keys}
              listsOwnKeysOnly={listsOwnKeysOnly}
              mayList={mayList}
              isPending={isPending}
              isError={isError}
              errorMessage={error?.message}
              onCreateOpen={mayCreate ? openCreateKey : undefined}
              onDelete={(id) => Promise.resolve(deletion.request(id))}
              onBulkDelete={(ids) => Promise.resolve(deletion.requestBulk(ids))}
              canRevoke={mayRevoke}
              onRotate={rotation.request}
              canRotate={rotation.canRotate}
              creatorFor={creatorFor}
            />
          </TabPanel>
          <TabPanel>
            <ConnectionDetailsTab />
          </TabPanel>
        </TabPanels>
      </Tabs>

      <ConfirmDialog
        open={deletion.pendingIds !== null}
        onClose={deletion.cancel}
        onConfirm={deletion.confirm}
        {...deletion.dialogCopy}
      />

      <ConfirmDialog
        open={rotation.pendingKeyId !== null}
        onClose={rotation.cancel}
        onConfirm={rotation.confirm}
        title="Rotate access key"
        description="The key keeps its name, permissions and buckets, and gets a new access key ID and secret. The current secret stops working as soon as the new one is issued, so update anything using it."
        confirmLabel="Rotate key"
      />

      {rotation.credentials && (
        <SaveCredentialsModal
          open={true}
          onDone={rotation.dismissCredentials}
          credentials={rotation.credentials}
        />
      )}
    </PageLayout>
  );
}
