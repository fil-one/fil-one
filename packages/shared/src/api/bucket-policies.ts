import { z } from 'zod';

/**
 * Bucket policies, as the Forge storage system stores them (fil-one/RFC#30,
 * "Bucket policies").
 *
 * A policy is one bucket's own document: a list of statements, each naming an
 * effect, the principals it applies to, and the S3 actions it covers. The
 * console keeps no copy; it reads the document from the orchestrator, edits it,
 * and writes it back under the ETag it read. Principals are console user ids,
 * which the orchestrator stores verbatim and never interprets.
 *
 * This module is the one place the wire shape is spelled out. The RFC review
 * still weighs an AWS-style nested principal object, so a change to the shape
 * is a change here and nowhere else.
 */

/**
 * The actions a statement may carry: the storage system's S3 permission set
 * without the three bucket-level actions. `s3:CreateBucket` and
 * `s3:DeleteBucket` act outside the bucket whose policy would grant them, and
 * `s3:ListAllMyBuckets` is held by every principal.
 */
export const POLICY_ACTIONS = [
  's3:GetObject',
  's3:GetObjectVersion',
  's3:GetObjectRetention',
  's3:GetObjectLegalHold',
  's3:ListBucket',
  's3:ListBucketVersions',
  's3:ListBucketMultipartUploads',
  's3:ListMultipartUploadParts',
  's3:PutObject',
  's3:AbortMultipartUpload',
  's3:PutObjectRetention',
  's3:PutObjectLegalHold',
  's3:DeleteObject',
  's3:DeleteObjectVersion',
] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

/** Stands for every action in {@link POLICY_ACTIONS}, and never for the three excluded ones. */
export const POLICY_ACTION_WILDCARD = 's3:*';
export type PolicyActionOrWildcard = PolicyAction | typeof POLICY_ACTION_WILDCARD;

export const POLICY_ACTIONS_WITH_WILDCARD = [...POLICY_ACTIONS, POLICY_ACTION_WILDCARD] as const;

/** How the editor groups the actions. Order is display order. */
export const POLICY_ACTION_GROUPS = ['read', 'list', 'write', 'delete', 'protection'] as const;
export type PolicyActionGroup = (typeof POLICY_ACTION_GROUPS)[number];

export const POLICY_ACTION_GROUP_LABELS: Record<PolicyActionGroup, string> = {
  read: 'Read objects',
  list: 'List objects',
  write: 'Write objects',
  delete: 'Delete objects',
  protection: 'Data protection',
};

export const POLICY_ACTION_LABELS: Record<
  PolicyAction,
  { label: string; description: string; group: PolicyActionGroup }
> = {
  's3:GetObject': {
    label: 'Read objects',
    description: 'Download and retrieve objects',
    group: 'read',
  },
  's3:GetObjectVersion': {
    label: 'Read object versions',
    description: 'Retrieve specific versions of objects',
    group: 'read',
  },
  's3:ListBucket': { label: 'List objects', description: 'Browse and list objects', group: 'list' },
  's3:ListBucketVersions': {
    label: 'List object versions',
    description: 'Browse version history of objects',
    group: 'list',
  },
  's3:ListBucketMultipartUploads': {
    label: 'List multipart uploads',
    description: 'See uploads in progress',
    group: 'list',
  },
  's3:ListMultipartUploadParts': {
    label: 'List upload parts',
    description: 'See the parts of an upload in progress',
    group: 'list',
  },
  's3:PutObject': {
    label: 'Write objects',
    description: 'Upload and overwrite objects',
    group: 'write',
  },
  's3:AbortMultipartUpload': {
    label: 'Abort multipart uploads',
    description: 'Cancel an upload in progress',
    group: 'write',
  },
  's3:DeleteObject': {
    label: 'Delete objects',
    description: 'Permanently remove objects',
    group: 'delete',
  },
  's3:DeleteObjectVersion': {
    label: 'Delete object versions',
    description: 'Remove specific object versions',
    group: 'delete',
  },
  's3:GetObjectRetention': {
    label: 'Read retention settings',
    description: 'View retention policies on objects',
    group: 'protection',
  },
  's3:GetObjectLegalHold': {
    label: 'Read legal hold status',
    description: 'View legal hold status on objects',
    group: 'protection',
  },
  's3:PutObjectRetention': {
    label: 'Set retention',
    description: 'Apply or modify retention policies',
    group: 'protection',
  },
  's3:PutObjectLegalHold': {
    label: 'Set legal hold',
    description: 'Apply or remove legal holds on objects',
    group: 'protection',
  },
};

/** The actions in a group, in {@link POLICY_ACTIONS} order. */
export function policyActionsInGroup(group: PolicyActionGroup): PolicyAction[] {
  return POLICY_ACTIONS.filter((action) => POLICY_ACTION_LABELS[action].group === group);
}

/**
 * The two actions only an Owner may grant. Writing retention or a legal hold
 * is redeemed at the storage system, where its use cannot be audit-logged, and
 * can make an object undeletable for years; the same pair needs
 * `privileged.grant` on a scoped key (`access-key-permissions.ts`).
 */
export const RETENTION_WRITE_ACTIONS = [
  's3:PutObjectRetention',
  's3:PutObjectLegalHold',
] as const satisfies readonly PolicyAction[];

export const POLICY_EFFECTS = ['allow', 'deny'] as const;
export type PolicyEffect = (typeof POLICY_EFFECTS)[number];

/** Names every live principal of the tenant. The one spelling of the wildcard. */
export const POLICY_WILDCARD_PRINCIPAL = '*';

export const PRINCIPAL_ID_MAX_LENGTH = 255;
export const POLICY_SID_MAX_LENGTH = 128;

const PrincipalIdSchema = z
  .string()
  .min(1, 'A principal id is required')
  .max(PRINCIPAL_ID_MAX_LENGTH, `A principal id is at most ${PRINCIPAL_ID_MAX_LENGTH} characters`)
  .refine((id) => id !== POLICY_WILDCARD_PRINCIPAL, {
    message: 'Name every member with the bare "*" string, never inside a list',
  });

/**
 * One statement. Strict, as the storage system's decoder is: a field this
 * schema does not know is refused rather than dropped, so a document the
 * console accepts is one the orchestrator will store.
 */
export const PolicyStatementSchema = z
  .object({
    /** An optional label. Stored and returned; nothing evaluates it. */
    sid: z.string().min(1).max(POLICY_SID_MAX_LENGTH).optional(),
    effect: z.enum(POLICY_EFFECTS),
    principal: z.union([
      z.literal(POLICY_WILDCARD_PRINCIPAL),
      z
        .array(PrincipalIdSchema)
        .min(1, 'A statement names at least one member')
        // A member named twice is still one member; keep the first mention.
        .transform((ids) => [...new Set(ids)]),
    ]),
    action: z
      .array(z.enum(POLICY_ACTIONS_WITH_WILDCARD))
      .min(1, 'A statement grants or denies at least one action'),
  })
  .strict();

export type PolicyStatement = z.infer<typeof PolicyStatementSchema>;

/**
 * The document. An empty statement list is refused: a bucket with no
 * statements has no policy, and the caller deletes it instead.
 */
export const BucketPolicySchema = z
  .object({
    statement: z.array(PolicyStatementSchema).min(1, 'A policy has at least one statement'),
  })
  .strict();

export type BucketPolicy = z.infer<typeof BucketPolicySchema>;

/** Whether a statement applies to a principal: it names them, or it names everyone. */
export function statementNames(statement: PolicyStatement, principalId: string): boolean {
  return (
    statement.principal === POLICY_WILDCARD_PRINCIPAL || statement.principal.includes(principalId)
  );
}

/** The actions a statement carries, with the wildcard expanded. */
export function expandActions(actions: readonly PolicyActionOrWildcard[]): PolicyAction[] {
  return actions.includes(POLICY_ACTION_WILDCARD)
    ? [...POLICY_ACTIONS]
    : (actions as PolicyAction[]);
}

/**
 * What a principal may do on the bucket: the union of the `allow` statements
 * naming them minus the union of the `deny` statements naming them, sorted.
 * The storage system computes the same thing on every request; this copy
 * serves previews and the in-memory fake, and must agree with it.
 */
export function effectiveActions(policy: BucketPolicy, principalId: string): PolicyAction[] {
  const allowed = new Set<PolicyAction>();
  const denied = new Set<PolicyAction>();
  for (const statement of policy.statement) {
    if (!statementNames(statement, principalId)) continue;
    const target = statement.effect === 'allow' ? allowed : denied;
    for (const action of expandActions(statement.action)) target.add(action);
  }
  return [...allowed].filter((action) => !denied.has(action)).sort();
}

/**
 * The retention grants a document makes: each principal (or `*`) that an
 * `allow` statement gives a retention or legal-hold write, keyed with the
 * action. `s3:*` counts, since it expands to both. A `deny` never counts:
 * withholding the pair is not a grant.
 */
function retentionGrants(policy: BucketPolicy | null): Set<string> {
  const grants = new Set<string>();
  for (const statement of policy?.statement ?? []) {
    if (statement.effect !== 'allow') continue;
    const writes = expandActions(statement.action).filter((action) =>
      (RETENTION_WRITE_ACTIONS as readonly PolicyAction[]).includes(action),
    );
    const principals =
      statement.principal === POLICY_WILDCARD_PRINCIPAL ? ['*'] : statement.principal;
    for (const principal of principals) {
      for (const action of writes) grants.add(`${principal}|${action}`);
    }
  }
  return grants;
}

/**
 * Whether `next` grants a retention or legal-hold write that `current` does
 * not, which only an Owner may do. Compared against the stored document rather
 * than read off the new one alone: the roster statement the console writes for
 * Owners carries `s3:*`, so every console-created bucket already grants the
 * pair, and an Admin editing an unrelated statement is not granting it again.
 * A grant to everyone covers every named principal.
 */
export function addsRetentionGrants(current: BucketPolicy | null, next: BucketPolicy): boolean {
  const before = retentionGrants(current);
  return [...retentionGrants(next)].some((grant) => {
    const action = grant.slice(grant.indexOf('|') + 1);
    return !before.has(grant) && !before.has(`*|${action}`);
  });
}

/**
 * The statements the console writes by their labels: the roster pair it keeps
 * in step with the org's Owners and Admins, and the creator's, written once
 * on create and left alone afterwards.
 */
export const ROSTER_OWNERS_SID = 'filone-owners';
export const ROSTER_ADMINS_SID = 'filone-admins';
export const ROSTER_CREATOR_SID = 'filone-creator';

/**
 * How a roster statement is titled where a person reads it. A statement Fil
 * One writes is matched by its sid, so the console shows the label and refuses
 * to rename it.
 */
export const ROSTER_SID_LABELS: Record<string, string> = {
  [ROSTER_OWNERS_SID]: 'Owners',
  [ROSTER_ADMINS_SID]: 'Admins',
  [ROSTER_CREATOR_SID]: 'Bucket creator',
};

/**
 * The prefix the roster sids share. A statement a person names may not take
 * it: the fan-out matches on those sids, so a collision would have their
 * statement rewritten the next time a role changes.
 */
export const RESERVED_SID_PREFIX = 'filone-';

export function isReservedSid(sid: string): boolean {
  return sid.startsWith(RESERVED_SID_PREFIX);
}

/**
 * Every action but the two retention writes: what an Admin, and a Member who
 * created the bucket, receives. An Owner may still grant the pair to an Admin on
 * one bucket, which is why the roster statement lists actions rather than
 * pairing `s3:*` with a `deny`.
 */
export const ROSTER_ADMIN_ACTIONS: PolicyAction[] = POLICY_ACTIONS.filter(
  (action) => !(RETENTION_WRITE_ACTIONS as readonly PolicyAction[]).includes(action),
);

/**
 * The roster statements for a bucket: Owners hold `s3:*`, Admins hold
 * {@link ROSTER_ADMIN_ACTIONS}. A statement that would name nobody is left
 * out. Written on every bucket the console creates, and rewritten by the
 * role-change fan-out.
 */
export function rosterStatements({
  owners,
  admins,
}: {
  owners: readonly string[];
  admins: readonly string[];
}): PolicyStatement[] {
  const ownerIds = [...new Set(owners)];
  const adminIds = [...new Set(admins)].filter((id) => !ownerIds.includes(id));

  const statements: PolicyStatement[] = [];
  if (ownerIds.length > 0) {
    statements.push({
      sid: ROSTER_OWNERS_SID,
      effect: 'allow',
      principal: ownerIds,
      action: [POLICY_ACTION_WILDCARD],
    });
  }
  if (adminIds.length > 0) {
    statements.push({
      sid: ROSTER_ADMINS_SID,
      effect: 'allow',
      principal: adminIds,
      action: [...ROSTER_ADMIN_ACTIONS],
    });
  }
  return statements;
}

/**
 * The policy a new bucket carries in its create request: the roster, and the
 * creator with the Admin actions in a statement of their own. Their own rather
 * than a seat in the Admins statement, because the role-change fan-out
 * rewrites the roster statements from the membership rows and would drop a
 * Member from a statement that is meant to follow the Admins. An Owner or
 * Admin creator is already named and gets no second statement.
 */
export function defaultBucketPolicy({
  owners,
  admins,
  creatorId,
}: {
  owners: readonly string[];
  admins: readonly string[];
  creatorId: string;
}): BucketPolicy {
  const statement = rosterStatements({ owners, admins });
  if (!owners.includes(creatorId) && !admins.includes(creatorId)) {
    statement.push({
      sid: ROSTER_CREATOR_SID,
      effect: 'allow',
      principal: [creatorId],
      action: [...ROSTER_ADMIN_ACTIONS],
    });
  }
  return { statement };
}

/**
 * A policy with its roster statements replaced by fresh ones and every other
 * statement kept in place, the creator's included. What the role-change
 * fan-out writes. Returns null when the result would carry no statement, which
 * means "delete the policy".
 */
export function withRosterStatements(
  policy: BucketPolicy | null,
  roster: { owners: readonly string[]; admins: readonly string[] },
): BucketPolicy | null {
  const others = (policy?.statement ?? []).filter(
    (statement) => statement.sid !== ROSTER_OWNERS_SID && statement.sid !== ROSTER_ADMINS_SID,
  );
  const statement = [...rosterStatements(roster), ...others];
  return statement.length > 0 ? { statement } : null;
}

// ── Console API shapes ────────────────────────────────────────────────

/** `GET /api/buckets/{name}/policy?region=` */
export interface GetBucketPolicyResponse {
  policy: BucketPolicy;
  /** Opaque. Sent back on the next write so a stale edit loses. */
  etag: string;
}

/**
 * `PUT /api/buckets/{name}/policy?region=`. `etag` is the value the last read
 * returned; absent, the write creates the bucket's first policy and is refused
 * if one exists.
 */
export const PutBucketPolicyRequestSchema = z
  .object({
    policy: BucketPolicySchema,
    etag: z.string().min(1).optional(),
  })
  .strict();

export type PutBucketPolicyRequest = z.infer<typeof PutBucketPolicyRequestSchema>;

export interface PutBucketPolicyResponse {
  etag: string;
  /** True when this write created the policy, false when it replaced one. */
  created: boolean;
}

/** One bucket a principal reaches, with what they may do there. */
export interface MemberBucketAccess {
  bucketName: string;
  actions: PolicyAction[];
}
