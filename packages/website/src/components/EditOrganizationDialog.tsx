import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { OrgNameSchema } from '@filone/shared';
import type { MeResponse } from '@filone/shared';

import { Button } from './Button';
import { FormField } from './FormField';
import { Input } from './Input';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal';
import { useToast } from './Toast';
import { errorMessageOf, updateOrg } from '../lib/api.js';
import { queryKeys } from '../lib/query-client.js';
import { useOrgSlug } from '../lib/use-org-path.js';

/**
 * Write a landed rename into every cache that reads the name (and, when the
 * rename rotated it, the slug).
 *
 * Both `/me` keys, because Settings reads the one with MFA included and the
 * rest of the console reads the other, and `memberships` alongside `orgName`:
 * the switcher reads the name from the list, so patching one and not the other
 * renames the org in the header and leaves the old name in the switcher until
 * `/me` is refetched. Leaving `slug` out of the patch when the response
 * carries none matters for a pre-backfill org confirming its unchanged name —
 * it has no slug to write, and writing `undefined` over one that already
 * existed would erase it.
 */
function applyRename(client: QueryClient, orgName: string, slug: string | undefined): void {
  const patch = (old: MeResponse | undefined): MeResponse | undefined =>
    old
      ? {
          ...old,
          orgName,
          ...(slug ? { slug } : {}),
          memberships: old.memberships?.map((membership) =>
            membership.orgId === old.orgId
              ? { ...membership, orgName, ...(slug ? { slug } : {}) }
              : membership,
          ),
        }
      : old;

  client.setQueryData<MeResponse>(queryKeys.me, patch);
  client.setQueryData<MeResponse>(queryKeys.meWithMfa, patch);
}

/**
 * Follow the org onto its new URL when a rename rotated the slug.
 *
 * The route the caller is on is scoped by the old slug, which is no longer
 * valid: `legacy-route-redirect.ts`'s own rule is that a non-active slug falls
 * back to the active org's dashboard rather than renders the page it named, so
 * staying put would land the current page on the next navigation or reload
 * rather than keeping it. Only the leading `$orgSlug` segment changes — the
 * rest of the path, and any search or hash, ride along unchanged.
 *
 * A dynamic import, the same reason `switchToOrg` uses one: `router.ts` pulls
 * in every route, several of which import this module's tree at the top
 * level, so a static import back here would resolve before the router's own
 * module body has finished running.
 */
async function followRenamedSlug(fromSlug: string, toSlug: string): Promise<void> {
  const { router } = await import('../router.js');
  const { pathname, href } = router.state.location;
  if (pathname !== `/${fromSlug}` && !pathname.startsWith(`/${fromSlug}/`)) return;
  await router.navigate({ to: `/${toSlug}${href.slice(`/${fromSlug}`.length)}`, replace: true });
}

export type EditOrganizationDialogProps = {
  open: boolean;
  onClose: () => void;
  /** The name as it stands, which the field opens on. */
  orgName: string;
};

/**
 * Rename the organization.
 *
 * A dialog rather than a tab: the name is the one thing here anybody edits, and
 * a whole tab holding one field read as a page with nothing on it.
 */
export function EditOrganizationDialog({ open, onClose, orgName }: EditOrganizationDialogProps) {
  const { toast } = useToast();
  const client = useQueryClient();
  const currentOrgSlug = useOrgSlug();

  const [name, setName] = useState(orgName);
  const [error, setError] = useState<string | null>(null);

  // Reopening starts from what the org is called now, not from whatever was
  // last typed and abandoned.
  useEffect(() => {
    if (open) {
      setName(orgName);
      setError(null);
    }
  }, [open, orgName]);

  const rename = useMutation({
    mutationFn: (next: string) => updateOrg({ name: next }),
    onSuccess: (result) => {
      applyRename(client, result.name, result.slug);
      toast.success(`This organization is called ${result.name} now`);
      onClose();
      if (result.slug && currentOrgSlug && result.slug !== currentOrgSlug) {
        void followRenamedSlug(currentOrgSlug, result.slug);
      }
    },
    onError: (err) => {
      setError(errorMessageOf(err, 'Failed to rename the organization'));
    },
  });

  // Against the trimmed value, because trimmed is what gets sent: otherwise a
  // trailing space alone counts as a change and the save renames the org to the
  // name it already has.
  const changed = name.trim() !== orgName;

  function save() {
    const parsed = OrgNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    setError(null);
    rename.mutate(parsed.data);
  }

  return (
    <Modal
      open={open}
      onClose={rename.isPending ? () => {} : onClose}
      size="sm"
      testId="edit-organization-dialog"
    >
      <ModalHeader onClose={rename.isPending ? undefined : onClose}>Edit organization</ModalHeader>
      <ModalBody>
        <FormField label="Organization name" htmlFor="edit-org-name" error={error ?? undefined}>
          <Input
            id="edit-org-name"
            value={name}
            invalid={!!error}
            disabled={rename.isPending}
            onChange={(value) => {
              setName(value);
              if (error) setError(null);
            }}
            placeholder="Your organization"
          />
        </FormField>
      </ModalBody>
      <ModalFooter fullWidth>
        <Button variant="ghost" size="md" onClick={onClose} disabled={rename.isPending}>
          Cancel
        </Button>
        <Button
          id="edit-org-save-button"
          variant="primary"
          size="md"
          onClick={save}
          disabled={rename.isPending || !changed}
        >
          {rename.isPending ? 'Saving...' : 'Save changes'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
