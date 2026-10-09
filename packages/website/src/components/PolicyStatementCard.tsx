import { PencilSimpleIcon, TrashIcon } from '@phosphor-icons/react/dist/ssr';
import type { PolicyActionGroup, PolicyActionOrWildcard, PolicyStatement } from '@filone/shared';
import {
  POLICY_ACTION_GROUPS,
  POLICY_ACTION_GROUP_LABELS,
  POLICY_ACTION_LABELS,
  POLICY_ACTION_WILDCARD,
  POLICY_WILDCARD_PRINCIPAL,
  getPolicyActionsInGroup,
} from '@filone/shared';

import { Badge, type BadgeColor } from './Badge.js';
import { Card } from './Card.js';
import { RowActionsMenu } from './RowActionsMenu.js';

/** How many members a statement names before the rest fold into one badge. */
const MAX_MEMBER_BADGES = 3;

/** A statement's Sid, otherwise "Statement N". */
export function getStatementTitle(statement: Pick<PolicyStatement, 'Sid'>, index: number): string {
  return statement.Sid ?? `Statement ${index + 1}`;
}

/**
 * Badge colour by risk. Reading and listing change nothing, writing can
 * overwrite objects, deleting can lose them, and changing data protection can
 * lift or lock retention.
 */
const ACTION_GROUP_BADGE_COLORS: Record<PolicyActionGroup, BadgeColor> = {
  read: 'blue',
  list: 'blue',
  write: 'amber',
  delete: 'red',
  protect: 'red',
};

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
            <div className="ml-auto">
              <RowActionsMenu
                aria-label={`Actions for ${title}`}
                actions={[
                  ...(onEdit
                    ? [{ label: 'Edit statement', icon: PencilSimpleIcon, onSelect: onEdit }]
                    : []),
                  ...(onRemove
                    ? [
                        {
                          label: 'Remove statement',
                          icon: TrashIcon,
                          destructive: true,
                          onSelect: onRemove,
                        },
                      ]
                    : []),
                ]}
              />
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

/**
 * A member the org no longer lists: removed while a policy still named them,
 * or an id from another org. The dashed outline sets them apart from members,
 * and the tooltip carries the id so an admin can tell which statement to clean.
 */
function UnknownMemberBadge({ userId }: { userId: string }) {
  return (
    <Badge
      color="grey"
      size="sm"
      className="border border-dashed border-zinc-400"
      data-testid="policy-unknown-member"
      description={
        <span className="text-xs text-zinc-700">
          No longer a member of this organization
          <br />
          <span className="font-mono">{userId}</span>
        </span>
      }
    >
      Unknown member
    </Badge>
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
  const members = principal.map((userId) => ({ userId, name: getMemberName(userId) }));
  const visible = members.slice(0, MAX_MEMBER_BADGES);
  const folded = members.slice(MAX_MEMBER_BADGES);
  return (
    <>
      {visible.map(({ userId, name }) =>
        name === undefined ? (
          <UnknownMemberBadge key={userId} userId={userId} />
        ) : (
          <Badge key={userId} color="grey" size="sm">
            {name}
          </Badge>
        ),
      )}
      {folded.length > 0 && (
        <Badge
          color="grey"
          size="sm"
          data-testid="policy-more-members"
          description={
            <ul className="flex flex-col gap-0.5">
              {folded.map(({ userId, name }) => (
                <li key={userId} className="text-xs text-zinc-700">
                  {name ?? `Unknown member (${userId})`}
                </li>
              ))}
            </ul>
          }
        >
          +{folded.length} more
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
      <Badge color="red" size="sm">
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
            color={ACTION_GROUP_BADGE_COLORS[group]}
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
