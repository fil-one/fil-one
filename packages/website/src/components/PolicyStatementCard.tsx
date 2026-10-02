import { PencilSimpleIcon, TrashIcon } from '@phosphor-icons/react/dist/ssr';
import type { PolicyAction, PolicyStatement } from '@filone/shared';
import {
  POLICY_ACTION_GROUPS,
  POLICY_ACTION_GROUP_LABELS,
  POLICY_ACTION_LABELS,
  POLICY_ACTION_WILDCARD,
  POLICY_WILDCARD_PRINCIPAL,
  ROSTER_SID_LABELS,
  policyActionsInGroup,
} from '@filone/shared';

import { Badge } from './Badge.js';
import { Card } from './Card.js';
import { IconButton } from './IconButton.js';

/** How many members a statement names before the rest fold into one badge. */
const NAMED_MEMBERS_SHOWN = 3;

/**
 * How a statement is titled: the label for one Fil One writes, otherwise the
 * name it was given, otherwise its place in the policy.
 */
export function statementLabel(statement: Pick<PolicyStatement, 'sid'>, index: number): string {
  if (statement.sid) return ROSTER_SID_LABELS[statement.sid] ?? statement.sid;
  return `Statement ${index + 1}`;
}

export type PolicyStatementCardProps = {
  statement: PolicyStatement;
  /** Position in the policy, for the label of a statement with no `sid`. */
  index: number;
  /** How a member is named where a person reads it; a removed member has no name. */
  memberName: (userId: string) => string | undefined;
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
  memberName,
  onEdit,
  onRemove,
}: PolicyStatementCardProps) {
  const label = statementLabel(statement, index);
  return (
    <Card padding="md" shadow={false} data-testid="policy-statement">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          {statement.effect === 'allow' ? (
            <Badge color="green" size="sm" weight="medium">
              Allow
            </Badge>
          ) : (
            <Badge color="red" size="sm" weight="medium">
              Deny
            </Badge>
          )}
          <span className="text-ui font-medium text-zinc-900">{label}</span>
          {(onEdit || onRemove) && (
            <div className="ml-auto flex items-center gap-1">
              {onEdit && (
                <IconButton
                  icon={PencilSimpleIcon}
                  size="sm"
                  aria-label={`Edit ${label}`}
                  tooltip="Edit statement"
                  onClick={onEdit}
                />
              )}
              {onRemove && (
                <IconButton
                  icon={TrashIcon}
                  size="sm"
                  aria-label={`Remove ${label}`}
                  tooltip="Remove statement"
                  onClick={onRemove}
                />
              )}
            </div>
          )}
        </div>

        <Row label="Who">
          <PrincipalBadges principal={statement.principal} memberName={memberName} />
        </Row>
        <Row label="Actions">
          <ActionBadges actions={statement.action} />
        </Row>
      </div>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
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
  memberName,
}: {
  principal: PolicyStatement['principal'];
  memberName: (userId: string) => string | undefined;
}) {
  if (principal === POLICY_WILDCARD_PRINCIPAL) {
    return (
      <Badge color="grey" size="sm">
        Everyone in this organization
      </Badge>
    );
  }
  const names = principal.map((userId) => memberName(userId) ?? 'Unknown member');
  const shown = names.slice(0, NAMED_MEMBERS_SHOWN);
  const rest = names.slice(NAMED_MEMBERS_SHOWN);
  return (
    <>
      {shown.map((name, i) => (
        <Badge key={principal[i]} color="grey" size="sm">
          {name}
        </Badge>
      ))}
      {rest.length > 0 && (
        <Badge
          color="grey"
          size="sm"
          data-testid="policy-more-members"
          description={
            <ul className="flex flex-col gap-0.5">
              {rest.map((name, i) => (
                <li key={principal[NAMED_MEMBERS_SHOWN + i]} className="text-xs text-zinc-700">
                  {name}
                </li>
              ))}
            </ul>
          }
        >
          +{rest.length} more
        </Badge>
      )}
    </>
  );
}

/**
 * Actions by display group, one badge per group touched, listing the group's
 * members in the badge's tooltip. `s3:*` collapses to one badge, because
 * listing sixteen actions says less than "all of them".
 */
function ActionBadges({ actions }: { actions: PolicyStatement['action'] }) {
  if (actions.includes(POLICY_ACTION_WILDCARD)) {
    return (
      <Badge color="blue" size="sm">
        All actions
      </Badge>
    );
  }
  const granted = new Set(actions as PolicyAction[]);
  return (
    <>
      {POLICY_ACTION_GROUPS.map((group) => {
        const inGroup = policyActionsInGroup(group).filter((action) => granted.has(action));
        if (inGroup.length === 0) return null;
        return (
          <Badge
            key={group}
            color="blue"
            size="sm"
            data-testid={`policy-actions-${group}`}
            description={
              <ul className="flex flex-col gap-0.5">
                {inGroup.map((action) => (
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
