import { useEffect } from 'react';
import type { PolicyAction, PolicyActionOrWildcard } from '@filone/shared';
import {
  POLICY_ACTIONS,
  POLICY_ACTION_GROUPS,
  POLICY_ACTION_GROUP_LABELS,
  POLICY_ACTION_LABELS,
  POLICY_ACTION_WILDCARD,
  RETENTION_WRITE_ACTIONS,
  getPolicyActionsInGroup,
} from '@filone/shared';

import { usePermissions } from '../lib/use-permissions.js';
import { CheckboxRow } from './CheckboxRow.js';

export type PolicyActionFieldsProps = {
  value: PolicyActionOrWildcard[];
  onChange: (value: PolicyActionOrWildcard[]) => void;
};

/**
 * The actions a statement carries, grouped the way the card shows them, with
 * an "all actions" row that selects `s3:*`.
 *
 * Only callers with `privileged.grant` can add the retention writes or `s3:*`.
 * They are removed from a selection the caller cannot grant.
 */
export function PolicyActionFields({ value, onChange }: PolicyActionFieldsProps) {
  const { has, isPending, isError } = usePermissions();
  const canGrantRetention = has('privileged.grant');
  const canPickAction = (action: PolicyActionOrWildcard) =>
    canGrantRetention ||
    (action !== POLICY_ACTION_WILDCARD && !RETENTION_WRITE_ACTIONS.includes(action));

  const arePermissionsLoaded = !isPending && !isError;
  const allowedActions = value.filter(canPickAction);
  useEffect(() => {
    if (arePermissionsLoaded && allowedActions.length !== value.length) onChange(allowedActions);
  });

  const isWildcardSelected = value.includes(POLICY_ACTION_WILDCARD);
  const selectedActions = new Set(value);

  function toggleAll() {
    onChange(isWildcardSelected ? [] : [POLICY_ACTION_WILDCARD]);
  }

  function toggle(action: PolicyAction) {
    const next = selectedActions.has(action)
      ? value.filter((a) => a !== action)
      : [...value, action];
    // Every action picked one by one becomes `s3:*`, which also grants actions added later.
    const offered = POLICY_ACTIONS.filter(canPickAction);
    onChange(
      offered.every((a) => next.includes(a)) && canGrantRetention ? [POLICY_ACTION_WILDCARD] : next,
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="policy-actions">
      {canGrantRetention && (
        <CheckboxRow
          testId="policy-action-all"
          label="All actions"
          description="Every action below, including any added later"
          checked={isWildcardSelected}
          onChange={toggleAll}
        />
      )}
      {POLICY_ACTION_GROUPS.map((group) => {
        const actions = getPolicyActionsInGroup(group).filter(canPickAction);
        if (actions.length === 0) return null;
        return (
          <div key={group} className="flex flex-col" data-testid={`policy-actions-group-${group}`}>
            <p className="mb-1 px-3 text-meta font-medium uppercase tracking-wider text-zinc-400">
              {POLICY_ACTION_GROUP_LABELS[group]}
            </p>
            {actions.map((action) => (
              <CheckboxRow
                key={action}
                testId={`policy-action-${action}`}
                label={POLICY_ACTION_LABELS[action].label}
                description={POLICY_ACTION_LABELS[action].description}
                checked={isWildcardSelected || selectedActions.has(action)}
                disabled={isWildcardSelected}
                tooltip={isWildcardSelected ? 'All actions already covers this one.' : undefined}
                onChange={() => toggle(action)}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
