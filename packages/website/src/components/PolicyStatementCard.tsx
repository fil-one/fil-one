import { PencilSimpleIcon, TrashIcon } from '@phosphor-icons/react/dist/ssr';
import type { PolicyActionOrWildcard, PolicyStatement } from '@filone/shared';
import {
  POLICY_ACTION_GROUPS,
  POLICY_ACTION_GROUP_LABELS,
  POLICY_ACTION_LABELS,
  POLICY_ACTION_WILDCARD,
  POLICY_WILDCARD_PRINCIPAL,
  getPolicyActionsInGroup,
} from '@filone/shared';

import { Badge } from './Badge.js';
import { Card } from './Card.js';
import { IconButton } from './IconButton.js';

/** How many members a statement names before the rest fold into one badge. */
const MAX_MEMBER_BADGES = 3;

/** A statement's Sid, otherwise "Statement N". */
export function getStatementTitle(statement: Pick<PolicyStatement, 'Sid'>, index: number): string {
  return statement.Sid ?? `Statement ${index + 1}`;
}

export type PolicyStatementCardProps = {
  statement: PolicyStatement;
  /** Position in the policy, for the title of a statement with no `Sid`. */
  index: number;
  /** A member's display name; `undefined` shows as "Unknown member". */
  getMemberName: (userId: string) => string | undefined;
  onEdit?: () => void;
  onRemove?: () => void;
};

/**
 * One statement, laid out to be scanned: what it does, to whom, and which
 * actions. A card rather than a table row because a statement's three parts
 * each wrap on their own line at 375px, which no table column does.
 */
export function PolicyStatementCard({
  statement,
  index,
  getMemberName,
  onEdit,
  onRemove,
}: PolicyStatementCardProps) {
  const title = getStatementTitle(statement, index);
  return (
    <Card padding="md" shadow={false} data-testid="policy-statement">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Badge color={statement.Effect === 'Allow' ? 'green' : 'red'} size="sm" weight="medium">
            {statement.Effect}
          </Badge>
          <span className="text-ui font-medium text-zinc-900">{title}</span>
          {(onEdit || onRemove) && (
            <div className="ml-auto flex items-center gap-1">
              {onEdit && (
                <IconButton
                  icon={PencilSimpleIcon}
                  size="sm"
                  aria-label={`Edit ${title}`}
                  tooltip="Edit statement"
                  onClick={onEdit}
                />
              )}
              {onRemove && (
                <IconButton
                  icon={TrashIcon}
                  size="sm"
                  aria-label={`Remove ${title}`}
                  tooltip="Remove statement"
                  onClick={onRemove}
                />
              )}
            </div>
          )}
        </div>

        <StatementField label="Who">
          <PrincipalBadges principal={statement.Principal} getMemberName={getMemberName} />
        </StatementField>
        <StatementField label="Actions">
          <ActionBadges actions={statement.Action} />
        </StatementField>
      </div>
    </Card>
  );
}

function StatementField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-3">
      <span className="w-16 shrink-0 pt-0.5 text-meta font-medium uppercase tracking-wider text-zinc-400">
        {label}
      </span>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  );
}

function PrincipalBadges({
  principal,
  getMemberName,
}: {
  principal: PolicyStatement['Principal'];
  getMemberName: (userId: string) => string | undefined;
}) {
  if (principal === POLICY_WILDCARD_PRINCIPAL) {
    return (
      <Badge color="grey" size="sm">
        Everyone in this organization
      </Badge>
    );
  }
  const memberNames = principal.map((userId) => getMemberName(userId) ?? 'Unknown member');
  const visibleNames = memberNames.slice(0, MAX_MEMBER_BADGES);
  const foldedNames = memberNames.slice(MAX_MEMBER_BADGES);
  return (
    <>
      {visibleNames.map((name, i) => (
        <Badge key={principal[i]} color="grey" size="sm">
          {name}
        </Badge>
      ))}
      {foldedNames.length > 0 && (
        <Badge
          color="grey"
          size="sm"
          data-testid="policy-more-members"
          description={
            <ul className="flex flex-col gap-0.5">
              {foldedNames.map((name, i) => (
                <li key={principal[MAX_MEMBER_BADGES + i]} className="text-xs text-zinc-700">
                  {name}
                </li>
              ))}
            </ul>
          }
        >
          +{foldedNames.length} more
        </Badge>
      )}
    </>
  );
}

/**
 * Actions by display group, one badge per group touched, listing the group's
 * members in the badge's tooltip. `s3:*` collapses to one badge, because
 * listing every action says less than "all of them".
 */
function ActionBadges({ actions }: { actions: PolicyStatement['Action'] }) {
  if (actions.includes(POLICY_ACTION_WILDCARD)) {
    return (
      <Badge color="blue" size="sm">
        All actions
      </Badge>
    );
  }
  const grantedActions = new Set<PolicyActionOrWildcard>(actions);
  return (
    <>
      {POLICY_ACTION_GROUPS.map((group) => {
        const grantedInGroup = getPolicyActionsInGroup(group).filter((action) =>
          grantedActions.has(action),
        );
        if (grantedInGroup.length === 0) return null;
        return (
          <Badge
            key={group}
            color="blue"
            size="sm"
            data-testid={`policy-actions-${group}`}
            description={
              <ul className="flex flex-col gap-0.5">
                {grantedInGroup.map((action) => (
                  <li key={action} className="text-xs text-zinc-700">
                    {POLICY_ACTION_LABELS[action].label}
                  </li>
                ))}
              </ul>
            }
          >
            {POLICY_ACTION_GROUP_LABELS[group]}
          </Badge>
        );
      })}
    </>
  );
}
