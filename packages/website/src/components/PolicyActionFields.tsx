import { useEffect } from 'react';
import type { PolicyAction, PolicyActionOrWildcard } from '@filone/shared';
import {
  POLICY_ACTIONS,
  POLICY_ACTION_GROUPS,
  POLICY_ACTION_GROUP_LABELS,
  POLICY_ACTION_LABELS,
  POLICY_ACTION_WILDCARD,
  RETENTION_WRITE_ACTIONS,
  policyActionsInGroup,
} from '@filone/shared';

import { usePermissions } from '../lib/use-permissions.js';
import { CheckboxRow } from './CheckboxRow.js';

export type PolicyActionFieldsProps = {
  value: PolicyActionOrWildcard[];
  onChange: (value: PolicyActionOrWildcard[]) => void;
};

const RETENTION_WRITES = new Set<string>(RETENTION_WRITE_ACTIONS);

/**
 * The actions a statement carries, grouped the way the card shows them, with
 * an "all actions" row that collapses the selection to `s3:*`.
 *
 * Setting retention or a legal hold is the console's privileged pair: only an
 * Owner may put either in a statement, and `s3:*` stands for both. So those
 * rows, and the all-actions row, are offered only to a caller holding
 * `privileged.grant`, and pruned from a selection made before a demotion, the
 * way the key form treats the same two granulars.
 */
export function PolicyActionFields({ value, onChange }: PolicyActionFieldsProps) {
  const { has, isPending, isError } = usePermissions();
  const mayGrantRetention = has('privileged.grant');
  const mayOffer = (action: PolicyActionOrWildcard) =>
    mayGrantRetention || (action !== POLICY_ACTION_WILDCARD && !RETENTION_WRITES.has(action));

  const ceilingKnown = !isPending && !isError;
  const allowed = value.filter(mayOffer);
  useEffect(() => {
    if (ceilingKnown && allowed.length !== value.length) onChange(allowed);
  });

  const all = value.includes(POLICY_ACTION_WILDCARD);
  const granted = new Set(value);

  function toggleAll() {
    onChange(all ? [] : [POLICY_ACTION_WILDCARD]);
  }

  function toggle(action: PolicyAction) {
    const next = granted.has(action) ? value.filter((a) => a !== action) : [...value, action];
    // Every offered action picked one by one is the wildcard, spelled out.
    const offered = POLICY_ACTIONS.filter(mayOffer);
    onChange(
      offered.every((a) => next.includes(a)) && mayGrantRetention ? [POLICY_ACTION_WILDCARD] : next,
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="policy-actions">
      {mayGrantRetention && (
        <CheckboxRow
          testId="policy-action-all"
          label="All actions"
          description="Every action below, including any added later"
          checked={all}
          onChange={toggleAll}
        />
      )}
      {POLICY_ACTION_GROUPS.map((group) => {
        const actions = policyActionsInGroup(group).filter(mayOffer);
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
                checked={all || granted.has(action)}
                disabled={all}
                tooltip={all ? 'All actions already covers this one.' : undefined}
                onChange={() => toggle(action)}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
