import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { OrgNameSchema } from '@filone/shared';
import type { MeResponse } from '@filone/shared';

import { Button } from '../components/Button';
import { FormField } from '../components/FormField';
import { Input } from '../components/Input';
import { RequirePermission } from '../components/RequirePermission';
import { Spinner } from '../components/Spinner';
import { useToast } from '../components/Toast';
import { errorMessageOf, getMe, updateOrg } from '../lib/api.js';
import { ME_STALE_TIME, queryKeys } from '../lib/query-client.js';
import { useHasPermission } from '../lib/use-permissions.js';

/**
 * Write a landed rename into every cache that reads the name.
 *
 * Both `/me` keys, because Settings reads the one with MFA included and the
 * rest of the console reads the other, and `memberships` alongside `orgName`:
 * the switcher reads the name from the list, so patching one and not the other
 * renames the org in the header and leaves the old name in the switcher until
 * `/me` is refetched.
 */
function applyRename(client: QueryClient, orgName: string): void {
  const patch = (old: MeResponse | undefined): MeResponse | undefined =>
    old
      ? {
          ...old,
          orgName,
          memberships: old.memberships?.map((membership) =>
            membership.orgId === old.orgId ? { ...membership, orgName } : membership,
          ),
        }
      : old;

  client.setQueryData<MeResponse>(queryKeys.me, patch);
  client.setQueryData<MeResponse>(queryKeys.meWithMfa, patch);
}

/**
 * The organization's own details — its name, today.
 *
 * It lived in Settings beside the caller's own name and email, which meant one
 * form saving to two endpoints and a partial-save path for when the rename was
 * refused and the profile was not. Split out, each is a form with one call
 * (FIL-1094).
 */
export function OrganizationGeneral() {
  const { toast } = useToast();
  const client = useQueryClient();
  const mayRename = useHasPermission('org.rename');

  const { data: me, isPending } = useQuery({
    queryKey: queryKeys.me,
    queryFn: () => getMe(),
    staleTime: ME_STALE_TIME,
  });

  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (!initialized && me) {
      setName(me.orgName ?? '');
      setInitialized(true);
    }
  }, [me, initialized]);

  const rename = useMutation({
    mutationFn: (next: string) => updateOrg({ name: next }),
    onSuccess: (result) => {
      setName(result.name);
      applyRename(client, result.name);
      toast.success(`This organization is called ${result.name} now`);
    },
    onError: (err) => {
      toast.error(errorMessageOf(err, 'Failed to rename the organization'));
    },
  });

  // Against the trimmed value, because trimmed is what gets sent: otherwise a
  // trailing space alone counts as a change and the save renames the org to the
  // name it already has.
  const changed = mayRename && name.trim() !== (me?.orgName ?? '');

  function save() {
    const parsed = OrgNameSchema.safeParse(name.trim());
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    setError(null);
    rename.mutate(parsed.data);
  }

  if (isPending || !me) {
    return (
      <div className="flex items-center justify-center p-16">
        <Spinner ariaLabel="Loading organization" />
      </div>
    );
  }

  // The read-only field rather than nothing, and the same one while `/me` is in
  // flight: the name is worth seeing whether or not you may change it, and an
  // edit that appears and then vanishes is worse than one that arrives late.
  const readOnly = <Input id="org-name" value={name} onChange={() => {}} disabled />;

  return (
    <div className="flex max-w-md flex-col gap-4">
      <FormField label="Organization name" htmlFor="org-name" error={error ?? undefined}>
        <RequirePermission permission="org.rename" fallback={readOnly} pending={readOnly}>
          <Input
            id="org-name"
            value={name}
            invalid={!!error}
            onChange={(value) => {
              setName(value);
              if (error) setError(null);
            }}
            placeholder="Your organization"
          />
        </RequirePermission>
      </FormField>

      {mayRename && (
        <div>
          <Button
            id="org-name-save-button"
            variant="primary"
            onClick={save}
            disabled={rename.isPending || !changed}
          >
            {rename.isPending ? 'Saving...' : 'Save changes'}
          </Button>
        </div>
      )}
    </div>
  );
}
