import { PencilSimpleIcon, TrashIcon } from '@phosphor-icons/react/dist/ssr';
import type { PolicyAction, PolicyActionGroup, PolicyStatement } from '@filone/shared';
import {
  POLICY_ACTION_GROUPS,
  POLICY_ACTION_GROUP_LABELS,
  POLICY_ACTION_LABELS,
  POLICY_ACTION_WILDCARD,
  POLICY_WILDCARD_PRINCIPAL,
  policyActionsInGroup,
} from '@filone/shared';

import { Badge, type BadgeColor } from './Badge.js';
import { Card } from './Card.js';
import { RowActionsMenu } from './RowActionsMenu.js';

/** How many members a statement names before the rest fold into one badge. */
const NAMED_MEMBERS_SHOWN = 3;

/**
 * Read and list are informational; write is a step up; delete and the
 * retention/legal-hold pair under `protection` are the highest-privilege
 * group (an Owner-only grant, see `addsRetentionGrants`). Colour follows that
 * risk, so a statement's blast radius reads at a glance instead of requiring
 * everything to be spelled out.
 */
const ACTION_GROUP_COLOR: Record<PolicyActionGroup, BadgeColor> = {
  read: 'blue',
  list: 'blue',
  write: 'amber',
  delete: 'red',
  protection: 'red',
};

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
  const label = statement.sid ?? `Statement ${index + 1}`;
  const summary = summarizeStatement(statement, memberName);
  return (
    <Card padding="md" shadow={false} data-testid="policy-statement">
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              {statement.effect === 'allow' ? (
                <Badge color="green" size="sm" weight="medium">
                  Allow
                </Badge>
              ) : (
                <Badge color="red" size="sm" weight="medium">
                  Deny
                </Badge>
              )}
              <span className="text-ui font-medium text-zinc-900">{summary}</span>
            </div>
            {statement.sid && <span className="text-meta text-zinc-400">{statement.sid}</span>}
          </div>
          {(onEdit || onRemove) && (
            <RowActionsMenu
              aria-label={`Actions for ${label}`}
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

/** A short sentence naming who the statement covers and what it does to them. */
function summarizeStatement(
  statement: PolicyStatement,
  memberName: (userId: string) => string | undefined,
): string {
  const who = summarizePrincipal(statement.principal, memberName);
  const wildcard = statement.action.includes(POLICY_ACTION_WILDCARD);
  if (statement.effect === 'allow') {
    return wildcard ? `${who} has full access` : `${who} can ${summarizeActions(statement.action)}`;
  }
  return wildcard
    ? `${who} is denied all access`
    : `${who} cannot ${summarizeActions(statement.action)}`;
}

function summarizePrincipal(
  principal: PolicyStatement['principal'],
  memberName: (userId: string) => string | undefined,
): string {
  if (principal === POLICY_WILDCARD_PRINCIPAL) return 'Everyone in this organization';
  return joinWithAnd(principal.map((userId) => memberName(userId) ?? 'an unknown member'));
}

function summarizeActions(actions: PolicyStatement['action']): string {
  const granted = new Set(actions as PolicyAction[]);
  const groups = POLICY_ACTION_GROUPS.filter((group) =>
    policyActionsInGroup(group).some((action) => granted.has(action)),
  );
  return joinWithAnd(groups.map((group) => POLICY_ACTION_GROUP_LABELS[group].toLowerCase()));
}

function joinWithAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
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
      <Badge color="red" size="sm">
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
            color={ACTION_GROUP_COLOR[group]}
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
