import { z } from 'zod';

/**
 * Bucket policies, as the Forge storage system stores them (fil-one/RFC#30,
 * "Bucket policies"): an AWS bucket policy document, reduced to what the
 * storage system evaluates.
 *
 * ```json
 * {
 *   "Version": "2012-10-17",
 *   "Statement": [{
 *     "Sid": "creator",
 *     "Effect": "Allow",
 *     "Principal": {"AWS": ["arn:aws:iam:::user/<userId>"]},
 *     "Action": ["s3:GetObject", "s3:ListBucket"],
 *     "Resource": ["arn:aws:s3:::<bucket>", "arn:aws:s3:::<bucket>/*"]
 *   }]
 * }
 * ```
 *
 * The console keeps no copy; it reads the document from the orchestrator,
 * edits it, and writes it back under the ETag it read, which travels in the
 * `ETag` and `If-Match` headers. A principal is a console user id, named by
 * its user ARN with an empty account field since the bucket already fixes the
 * tenant; `*` names every member. The helpers here convert at that boundary,
 * so the console's own code and UI handle bare user ids. `Resource` names the
 * policy's bucket, as the bucket ARN for the three bucket actions and the
 * objects ARN for every other action; {@link getStatementResources} derives
 * it from a statement's actions. The storage system returns the canonical
 * form: lists sorted and deduplicated, statements reordered.
 *
 * This module is the one place the wire shape is spelled out.
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
export const POLICY_ACTION_GROUPS = ['read', 'list', 'write', 'delete', 'protect'] as const;
export type PolicyActionGroup = (typeof POLICY_ACTION_GROUPS)[number];

export const POLICY_ACTION_GROUP_LABELS: Record<PolicyActionGroup, string> = {
  read: 'Read objects',
  list: 'List objects',
  write: 'Write objects',
  delete: 'Delete objects',
  protect: 'Manage data protection',
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
    group: 'protect',
  },
  's3:GetObjectLegalHold': {
    label: 'Read legal hold status',
    description: 'View legal hold status on objects',
    group: 'protect',
  },
  's3:PutObjectRetention': {
    label: 'Set retention',
    description: 'Apply or modify retention policies',
    group: 'protect',
  },
  's3:PutObjectLegalHold': {
    label: 'Set legal hold',
    description: 'Apply or remove legal holds on objects',
    group: 'protect',
  },
};

/** The actions in a group, in {@link POLICY_ACTIONS} order. */
export function getPolicyActionsInGroup(group: PolicyActionGroup): PolicyAction[] {
  return POLICY_ACTIONS.filter((action) => POLICY_ACTION_LABELS[action].group === group);
}

/**
 * The two actions only an Owner may grant. Writing retention or a legal hold
 * is redeemed at the storage system, where its use cannot be audit-logged, and
 * can make an object undeletable for years; the same pair needs
 * `privileged.grant` on a service key (`access-key-permissions.ts`).
 */
export const RETENTION_WRITE_ACTIONS: readonly PolicyAction[] = [
  's3:PutObjectRetention',
  's3:PutObjectLegalHold',
];

export const POLICY_EFFECTS = ['Allow', 'Deny'] as const;
export type PolicyEffect = (typeof POLICY_EFFECTS)[number];

/** Names every live principal of the tenant. The one spelling of the wildcard. */
export const POLICY_WILDCARD_PRINCIPAL = '*';

/** The policy language version the console writes. The storage system also reads the 2008 one. */
export const POLICY_VERSION = '2012-10-17' as const;
const POLICY_VERSIONS = [POLICY_VERSION, '2008-10-17'] as const;

export const PRINCIPAL_ID_MAX_LENGTH = 255;
export const POLICY_SID_MAX_LENGTH = 128;

const PRINCIPAL_ARN_PREFIX = 'arn:aws:iam:::user/';

/** The ARN a document names a member by. */
export function toPrincipalArn(userId: string): string {
  return PRINCIPAL_ARN_PREFIX + userId;
}

/** The member id a document's user ARN names. A value without the prefix is returned as is. */
export function fromPrincipalArn(arn: string): string {
  return arn.startsWith(PRINCIPAL_ARN_PREFIX) ? arn.slice(PRINCIPAL_ARN_PREFIX.length) : arn;
}

// A member is named by its console user id, which is a UUID (`middleware/auth.ts`).
const PrincipalIdSchema = z
  .uuid()
  .min(1)
  .max(PRINCIPAL_ID_MAX_LENGTH)
  .refine((id) => id !== POLICY_WILDCARD_PRINCIPAL);

const PrincipalArnSchema = z
  .string()
  .refine(
    (arn) =>
      arn.startsWith(PRINCIPAL_ARN_PREFIX) &&
      PrincipalIdSchema.safeParse(fromPrincipalArn(arn)).success,
    `A member is named by ${toPrincipalArn('<console user id>')}; "*" names everyone as the bare string`,
  );

const S3_RESOURCE_ARN = /^arn:aws:s3:::[^/*?]+(\/\*)?$/;

/**
 * One statement. Strict, as the storage system's decoder is: a field this
 * schema does not know is refused rather than dropped, so a document the
 * console accepts is one the orchestrator will store.
 */
export const PolicyStatementSchema = z
  .object({
    /** An optional label. Stored and returned; nothing evaluates it. */
    Sid: z.string().min(1).max(POLICY_SID_MAX_LENGTH).optional(),
    Effect: z.enum(POLICY_EFFECTS),
    Principal: z.union([
      z.literal(POLICY_WILDCARD_PRINCIPAL),
      z
        .object({
          AWS: z
            .array(PrincipalArnSchema)
            .min(1, 'A statement names at least one member')
            // A member named twice is still one member; keep the first mention.
            .transform((arns) => [...new Set(arns)]),
        })
        .strict(),
    ]),
    Action: z
      .array(z.enum(POLICY_ACTIONS_WITH_WILDCARD))
      .min(1, 'A statement grants or denies at least one action'),
    /** The bucket's ARN, its objects ARN, or both; see {@link getStatementResources}. */
    Resource: z
      .array(
        z.string().regex(S3_RESOURCE_ARN, 'A resource is a bucket or its objects, never a prefix'),
      )
      .min(1, 'A statement names the bucket it applies to'),
  })
  .strict();

export type PolicyStatement = z.infer<typeof PolicyStatementSchema>;
export type PolicyPrincipal = PolicyStatement['Principal'];

/**
 * The document. An empty statement list is refused: a bucket with no
 * statements has no policy, and the caller deletes it instead.
 */
export const BucketPolicySchema = z
  .object({
    Version: z.enum(POLICY_VERSIONS),
    Statement: z.array(PolicyStatementSchema).min(1, 'A policy has at least one statement'),
  })
  .strict();

export type BucketPolicy = z.infer<typeof BucketPolicySchema>;

/** The member ids a principal names; none for `*`. */
export function getPrincipalIds(principal: PolicyPrincipal): string[] {
  return principal === POLICY_WILDCARD_PRINCIPAL ? [] : principal.AWS.map(fromPrincipalArn);
}

/** The principal naming the given members, or everyone for `*`. */
export function toPolicyPrincipal(userIds: '*' | readonly string[]): PolicyPrincipal {
  return userIds === POLICY_WILDCARD_PRINCIPAL ? userIds : { AWS: userIds.map(toPrincipalArn) };
}

/**
 * The three actions that act on the bucket rather than on its objects. The
 * split is the storage system's, which evaluates a statement against the ARN
 * its actions need.
 */
const BUCKET_ACTIONS: readonly PolicyAction[] = [
  's3:ListBucket',
  's3:ListBucketMultipartUploads',
  's3:ListBucketVersions',
];

/**
 * What a statement's `Resource` must name for its actions on `bucketName`:
 * the bucket ARN for a bucket action, the objects ARN for an object action,
 * both for `s3:*`.
 */
export function getStatementResources(
  bucketName: string,
  actions: readonly PolicyActionOrWildcard[],
): string[] {
  const isWildcard = actions.includes(POLICY_ACTION_WILDCARD);
  const isBucketAction = (a: PolicyActionOrWildcard) => BUCKET_ACTIONS.includes(a as PolicyAction);
  const resources: string[] = [];
  if (isWildcard || actions.some(isBucketAction)) resources.push(`arn:aws:s3:::${bucketName}`);
  if (isWildcard || actions.some((a) => !isBucketAction(a)))
    resources.push(`arn:aws:s3:::${bucketName}/*`);
  return resources;
}

/** True when the statement's Principal is `*` or lists the principal. */
function isPrincipalInStatement(statement: PolicyStatement, principalId: string): boolean {
  return (
    statement.Principal === POLICY_WILDCARD_PRINCIPAL ||
    statement.Principal.AWS.includes(toPrincipalArn(principalId))
  );
}

/** The actions a statement carries, with the wildcard expanded. */
export function expandActions(actions: readonly PolicyActionOrWildcard[]): PolicyAction[] {
  return actions.includes(POLICY_ACTION_WILDCARD)
    ? [...POLICY_ACTIONS]
    : (actions as PolicyAction[]);
}

/**
 * What a principal may do on the bucket: the union of the `Allow` statements
 * that apply to them minus the union of the `Deny` statements that apply to
 * them, sorted. The storage system computes the same thing on every request;
 * this copy serves previews and the in-memory fake, and must agree with it.
 */
export function getEffectiveActions(policy: BucketPolicy, principalId: string): PolicyAction[] {
  const allowed = new Set<PolicyAction>();
  const denied = new Set<PolicyAction>();
  for (const statement of policy.Statement) {
    if (!isPrincipalInStatement(statement, principalId)) continue;
    const target = statement.Effect === 'Allow' ? allowed : denied;
    for (const action of expandActions(statement.Action)) target.add(action);
  }
  return [...allowed].filter((action) => !denied.has(action)).sort();
}

/** Every member id a document names outright. */
export function getNamedPrincipals(policy: BucketPolicy | null): string[] {
  return (policy?.Statement ?? []).flatMap((statement) => getPrincipalIds(statement.Principal));
}

/**
 * Whether `next` grants a retention or legal-hold write that `current` does
 * not, which only an Owner may do. Compared as the storage system evaluates
 * them, per principal with deny winning, against the stored document rather
 * than read off the new one alone: the roster statement the console writes for
 * Owners carries `s3:*`, so every console-created bucket already grants the
 * pair, and an Admin editing an unrelated statement is not granting it again.
 * The wildcard principal stands for a member neither document names.
 */
export function hasNewRetentionGrants(current: BucketPolicy | null, next: BucketPolicy): boolean {
  const principals = new Set([
    POLICY_WILDCARD_PRINCIPAL,
    ...getNamedPrincipals(current),
    ...getNamedPrincipals(next),
  ]);
  for (const principal of principals) {
    const before = current ? getEffectiveActions(current, principal) : [];
    const after = getEffectiveActions(next, principal);
    if (RETENTION_WRITE_ACTIONS.some((a) => after.includes(a) && !before.includes(a))) return true;
  }
  return false;
}

/**
 * Every action but the two retention writes. Those are Owner-only grants
 * (`privileged.grant`), so the statement the console writes for a bucket's
 * creator leaves them out; an Owner adds them to a statement by hand.
 */
export const CREATOR_ACTIONS: PolicyAction[] = POLICY_ACTIONS.filter(
  (action) => !RETENTION_WRITE_ACTIONS.includes(action),
);

/**
 * A statement on `bucketName` for `principal` (member ids, or `*`), its
 * Resource derived from the actions.
 */
export function buildStatement({
  bucketName,
  effect = 'Allow',
  principal,
  actions,
  sid,
}: {
  bucketName: string;
  effect?: PolicyEffect;
  principal: '*' | readonly string[];
  actions: PolicyActionOrWildcard[];
  sid?: string;
}): PolicyStatement {
  return {
    ...(sid === undefined ? {} : { Sid: sid }),
    Effect: effect,
    Principal: toPolicyPrincipal(principal),
    Action: actions,
    Resource: getStatementResources(bucketName, actions),
  };
}

/**
 * The policy a new bucket carries in its create request: one Allow naming the
 * creator, whatever their role. An ordinary statement, shown under its Sid and
 * edited or removed like any other. The console writes no other statement and
 * never rewrites a policy on its own.
 */
export function getCreatorBucketPolicy({
  creatorId,
  bucketName,
}: {
  creatorId: string;
  bucketName: string;
}): BucketPolicy {
  return {
    Version: POLICY_VERSION,
    Statement: [
      buildStatement({
        bucketName,
        principal: [creatorId],
        actions: [...CREATOR_ACTIONS],
        sid: 'creator',
      }),
    ],
  };
}

// ── Console API shapes ────────────────────────────────────────────────

/**
 * `GET /api/buckets/{name}/policy?region=`. The `ETag` response header carries
 * the version a write sends back in `If-Match`.
 */
export interface GetBucketPolicyResponse {
  policy: BucketPolicy;
}

/**
 * `PUT /api/buckets/{name}/policy?region=`, answered 204 with the new `ETag`.
 * As on S3, `If-Match` replaces only that version, `If-None-Match: *` creates
 * only the first, and neither overwrites.
 */
export const PutBucketPolicyRequestSchema = z.object({ policy: BucketPolicySchema }).strict();

export type PutBucketPolicyRequest = z.infer<typeof PutBucketPolicyRequestSchema>;

/** One bucket a principal reaches, with what they may do there. */
export interface MemberBucketAccess {
  bucketName: string;
  actions: PolicyAction[];
}
