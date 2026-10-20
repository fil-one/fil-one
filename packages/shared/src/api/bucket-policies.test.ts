import { describe, it, expect } from 'vitest';
import {
  BucketPolicySchema,
  POLICY_ACTIONS,
  POLICY_ACTION_LABELS,
  POLICY_ACTION_GROUPS,
  POLICY_VERSION,
  PutBucketPolicyRequestSchema,
  RETENTION_WRITE_ACTIONS,
  CREATOR_ACTIONS,
  fromPrincipalArn,
  getCreatorBucketPolicy,
  getEffectiveActions,
  getNamedPrincipals,
  getPolicyActionsInGroup,
  getPrincipalIds,
  getStatementResources,
  hasNewRetentionGrants,
  toPolicyPrincipal,
  toPrincipalArn,
} from './bucket-policies.ts';
import type { BucketPolicy, PolicyStatement } from './bucket-policies.ts';

// Arbitrary console user ids. The schema accepts only UUIDs.
const PRINCIPAL_A = '00000000-0000-4000-8000-00000000000a';
const PRINCIPAL_B = '00000000-0000-4000-8000-00000000000b';
const PRINCIPAL_C = '00000000-0000-4000-8000-00000000000c';
const BUCKET = 'photos';
const BUCKET_ARN = 'arn:aws:s3:::photos';
const OBJECTS_ARN = 'arn:aws:s3:::photos/*';
const BOTH_ARNS = [BUCKET_ARN, OBJECTS_ARN];
/** The AWS principal naming the given members. */
const members = (...ids: string[]) => ({ AWS: ids.map(toPrincipalArn) });
/** A policy document over `statements`. */
const policy = (...statements: PolicyStatement[]): BucketPolicy => ({
  Version: POLICY_VERSION,
  Statement: statements,
});

const grantReadToPrincipalA = policy({
  Effect: 'Allow',
  Principal: members(PRINCIPAL_A),
  Action: ['s3:GetObject', 's3:ListBucket'],
  Resource: BOTH_ARNS,
});

describe('the policy vocabulary', () => {
  it.each(['s3:CreateBucket', 's3:DeleteBucket', 's3:ListAllMyBuckets'])(
    'does not offer the bucket-level action %s',
    (action) => {
      expect(POLICY_ACTIONS as readonly string[]).not.toContain(action);
    },
  );

  it('offers twenty-four actions', () => {
    expect(POLICY_ACTIONS).toHaveLength(24);
  });

  it('labels every action', () => {
    expect(Object.keys(POLICY_ACTION_LABELS).sort()).toStrictEqual([...POLICY_ACTIONS].sort());
  });

  it('places every action in exactly one display group', () => {
    const grouped = POLICY_ACTION_GROUPS.flatMap(getPolicyActionsInGroup);
    expect(grouped.sort()).toStrictEqual([...POLICY_ACTIONS].sort());
  });

  it.each([
    {
      name: 'the retention and legal-hold actions',
      group: 'protect',
      actions: [
        's3:GetObjectRetention',
        's3:GetObjectLegalHold',
        's3:PutObjectRetention',
        's3:PutObjectLegalHold',
      ],
    },
    {
      name: 'the object tagging actions',
      group: 'tags',
      actions: ['s3:GetObjectTagging', 's3:PutObjectTagging', 's3:DeleteObjectTagging'],
    },
    {
      name: 'the bucket configuration reads',
      group: 'bucket',
      actions: [
        's3:GetBucketAcl',
        's3:GetBucketCORS',
        's3:GetBucketLocation',
        's3:GetBucketObjectLockConfiguration',
        's3:GetBucketTagging',
        's3:GetBucketVersioning',
      ],
    },
  ] as const)('puts $name in the $group group', ({ group, actions }) => {
    expect(getPolicyActionsInGroup(group)).toStrictEqual(actions);
  });

  it('puts reading object attributes in the read group', () => {
    expect(getPolicyActionsInGroup('read')).toContain('s3:GetObjectAttributes');
  });

  it('gives a creator every action but the two retention writes', () => {
    expect(CREATOR_ACTIONS).toStrictEqual([
      's3:GetObject',
      's3:GetObjectVersion',
      's3:GetObjectAttributes',
      's3:GetObjectRetention',
      's3:GetObjectLegalHold',
      's3:ListBucket',
      's3:ListBucketVersions',
      's3:ListBucketMultipartUploads',
      's3:ListMultipartUploadParts',
      's3:PutObject',
      's3:AbortMultipartUpload',
      's3:DeleteObject',
      's3:DeleteObjectVersion',
      's3:GetObjectTagging',
      's3:PutObjectTagging',
      's3:DeleteObjectTagging',
      's3:GetBucketAcl',
      's3:GetBucketCORS',
      's3:GetBucketLocation',
      's3:GetBucketObjectLockConfiguration',
      's3:GetBucketTagging',
      's3:GetBucketVersioning',
    ]);
  });
});

describe('principal ARNs', () => {
  it('names a member by the user ARN with an empty account field', () => {
    expect(toPrincipalArn(PRINCIPAL_A)).toBe(`arn:aws:iam:::user/${PRINCIPAL_A}`);
  });

  it('reads the member id back from the ARN', () => {
    expect(fromPrincipalArn(toPrincipalArn(PRINCIPAL_A))).toBe(PRINCIPAL_A);
  });

  it('lists the ids a principal names, and none for everyone', () => {
    expect(getPrincipalIds(members(PRINCIPAL_A, PRINCIPAL_B))).toStrictEqual([
      PRINCIPAL_A,
      PRINCIPAL_B,
    ]);
    expect(getPrincipalIds('*')).toStrictEqual([]);
  });

  it('builds the principal from member ids', () => {
    expect(toPolicyPrincipal([PRINCIPAL_A])).toStrictEqual(members(PRINCIPAL_A));
  });
});

describe('getStatementResources', () => {
  it.each([
    { name: 'a bucket listing', action: 's3:ListBucket' },
    { name: 'a bucket configuration read', action: 's3:GetBucketVersioning' },
  ] as const)('names the bucket for $name', ({ action }) => {
    expect(getStatementResources(BUCKET, [action])).toStrictEqual([BUCKET_ARN]);
  });

  it.each([
    { name: 'an object action', action: 's3:GetObject' },
    { name: 'an object tagging action', action: 's3:PutObjectTagging' },
  ] as const)('names the objects for $name', ({ action }) => {
    expect(getStatementResources(BUCKET, [action])).toStrictEqual([OBJECTS_ARN]);
  });

  it.each([
    { name: 's3:*', actions: ['s3:*'] as const },
    {
      name: 'a bucket action beside an object action',
      actions: ['s3:GetObject', 's3:ListBucketVersions'] as const,
    },
  ])('names both for $name', ({ actions }) => {
    expect(getStatementResources(BUCKET, actions)).toStrictEqual(BOTH_ARNS);
  });
});

describe('BucketPolicySchema', () => {
  const validStatement = {
    Effect: 'Allow',
    Principal: members(PRINCIPAL_A),
    Action: ['s3:GetObject'],
    Resource: [OBJECTS_ARN],
  };
  const withStatement = (changes: Record<string, unknown>) => ({
    Version: POLICY_VERSION,
    Statement: [{ ...validStatement, ...changes }],
  });
  // zod reports the object branch's issue on its own once the input is an object.
  const principalIssue = (code: string) => ({
    code,
    path: ['Statement', 0, 'Principal', 'AWS', 0],
  });

  it.each([
    {
      name: 'the shape the storage system stores',
      input: {
        Version: POLICY_VERSION,
        Statement: [
          {
            Sid: 'owners',
            Effect: 'Allow',
            Principal: members(PRINCIPAL_A, PRINCIPAL_B),
            Action: ['s3:*'],
            Resource: BOTH_ARNS,
          },
          {
            Effect: 'Deny',
            Principal: '*',
            Action: ['s3:PutObjectRetention'],
            Resource: [OBJECTS_ARN],
          },
        ],
      },
    },
    { name: 'a principal named by user ARN', input: withStatement({}) },
    {
      name: 'an object tagging action',
      input: withStatement({ Action: ['s3:GetObjectTagging'] }),
    },
    { name: 'the wildcard principal as the bare string', input: withStatement({ Principal: '*' }) },
    {
      name: 'the 2008 policy language version',
      input: { ...withStatement({}), Version: '2008-10-17' },
    },
  ])('accepts $name', ({ input }) => {
    expect(BucketPolicySchema.safeParse(input)).toMatchObject({ success: true });
  });

  it('keeps each principal once, in the order first given', () => {
    const parsed = BucketPolicySchema.parse(
      withStatement({ Principal: members(PRINCIPAL_B, PRINCIPAL_A, PRINCIPAL_B) }),
    );
    expect(parsed).toStrictEqual(withStatement({ Principal: members(PRINCIPAL_B, PRINCIPAL_A) }));
  });

  it.each([
    {
      name: 'a statement field it does not define',
      // AWS's conditions, which the storage system refuses
      input: withStatement({ Condition: {} }),
      issue: { code: 'unrecognized_keys', keys: ['Condition'], path: ['Statement', 0] },
    },
    {
      name: 'a document field it does not define',
      // misspelled, should have been Version
      input: { ...withStatement({}), version: '2012-10-17' },
      issue: { code: 'unrecognized_keys', keys: ['version'], path: [] },
    },
    {
      name: 'a missing Version',
      input: { Statement: withStatement({}).Statement },
      issue: { code: 'invalid_value', path: ['Version'] },
    },
    {
      name: 'a Version the storage system does not know',
      input: { ...withStatement({}), Version: '2026-01-01' },
      issue: { code: 'invalid_value', path: ['Version'] },
    },
    {
      name: 'the wildcard principal inside a list',
      input: withStatement({ Principal: { AWS: ['*'] } }),
      issue: principalIssue('custom'),
    },
    {
      name: 'a principal that is not a user ARN',
      input: withStatement({ Principal: { AWS: [PRINCIPAL_A] } }),
      issue: principalIssue('custom'),
    },
    {
      name: 'a user ARN whose id is not a UUID',
      input: withStatement({ Principal: { AWS: ['arn:aws:iam:::user/alice'] } }),
      issue: principalIssue('custom'),
    },
    {
      name: 'a principal key other than AWS',
      input: withStatement({ Principal: { Service: 's3.amazonaws.com' } }),
      issue: { code: 'invalid_union', path: ['Statement', 0, 'Principal'] },
    },
    {
      name: 'an empty statement list',
      input: { Version: POLICY_VERSION, Statement: [] },
      issue: { code: 'too_small', minimum: 1, path: ['Statement'] },
    },
    {
      name: 'an empty principal list',
      input: withStatement({ Principal: { AWS: [] } }),
      issue: { code: 'too_small', minimum: 1, path: ['Statement', 0, 'Principal', 'AWS'] },
    },
    {
      name: 'an empty action list',
      input: withStatement({ Action: [] }),
      issue: { code: 'too_small', minimum: 1, path: ['Statement', 0, 'Action'] },
    },
    {
      name: 'an action outside the vocabulary',
      input: withStatement({ Action: ['s3:CreateBucket'] }),
      issue: { code: 'invalid_value', path: ['Statement', 0, 'Action', 0] },
    },
    {
      name: 'an empty resource list',
      input: withStatement({ Resource: [] }),
      issue: { code: 'too_small', minimum: 1, path: ['Statement', 0, 'Resource'] },
    },
    {
      name: 'a resource that is a key prefix',
      input: withStatement({ Resource: ['arn:aws:s3:::photos/2026/*'] }),
      issue: { code: 'invalid_format', path: ['Statement', 0, 'Resource', 0] },
    },
    {
      name: 'an effect other than Allow or Deny',
      // lower case, should have been Allow
      input: withStatement({ Effect: 'allow' }),
      issue: { code: 'invalid_value', path: ['Statement', 0, 'Effect'] },
    },
  ])('refuses $name', ({ input, issue }) => {
    expect(BucketPolicySchema.safeParse(input)).toMatchObject({
      success: false,
      error: { issues: [issue] },
    });
  });
});

describe('PutBucketPolicyRequestSchema', () => {
  it('accepts a request carrying only the policy', () => {
    expect(PutBucketPolicyRequestSchema.safeParse({ policy: grantReadToPrincipalA })).toMatchObject(
      { success: true },
    );
  });

  it('refuses an etag in the body, which travels in the If-Match header', () => {
    expect(
      PutBucketPolicyRequestSchema.safeParse({ policy: grantReadToPrincipalA, etag: '"abc"' }),
    ).toMatchObject({
      success: false,
      error: { issues: [{ code: 'unrecognized_keys', keys: ['etag'], path: [] }] },
    });
  });
});

describe('getNamedPrincipals', () => {
  it('lists the member ids the document names, and skips everyone', () => {
    const doc = policy(
      ...grantReadToPrincipalA.Statement,
      { Effect: 'Deny', Principal: '*', Action: ['s3:DeleteObject'], Resource: [OBJECTS_ARN] },
      {
        Effect: 'Allow',
        Principal: members(PRINCIPAL_B),
        Action: ['s3:GetObject'],
        Resource: [OBJECTS_ARN],
      },
    );
    expect(getNamedPrincipals(doc)).toStrictEqual([PRINCIPAL_A, PRINCIPAL_B]);
  });
});

describe('getEffectiveActions', () => {
  const grant = (
    principal: PolicyStatement['Principal'],
    actions: PolicyStatement['Action'],
    effect: PolicyStatement['Effect'] = 'Allow',
  ): PolicyStatement => ({
    Effect: effect,
    Principal: principal,
    Action: actions,
    Resource: getStatementResources(BUCKET, actions),
  });

  it('returns the actions of Allow statements that list the principal, sorted', () => {
    const doc = policy(grant(members(PRINCIPAL_A), ['s3:PutObject', 's3:GetObject']));
    expect(getEffectiveActions(doc, PRINCIPAL_A)).toStrictEqual(['s3:GetObject', 's3:PutObject']);
  });

  it('expands the s3:* action to every action', () => {
    const doc = policy(grant(members(PRINCIPAL_A), ['s3:*']));
    expect(getEffectiveActions(doc, PRINCIPAL_A)).toStrictEqual([...POLICY_ACTIONS].sort());
  });

  it('removes the actions a Deny statement covers', () => {
    const doc = policy(
      ...grantReadToPrincipalA.Statement,
      grant(members(PRINCIPAL_A), ['s3:ListBucket'], 'Deny'),
    );
    expect(getEffectiveActions(doc, PRINCIPAL_A)).toStrictEqual(['s3:GetObject']);
  });

  it('applies an Allow statement with Principal "*" to a principal it does not list', () => {
    const doc = policy(grant('*', ['s3:GetObject']));
    expect(getEffectiveActions(doc, PRINCIPAL_A)).toStrictEqual(['s3:GetObject']);
  });

  it('applies a Deny statement with Principal "*" to a principal it does not list', () => {
    const doc = policy(...grantReadToPrincipalA.Statement, grant('*', ['s3:ListBucket'], 'Deny'));
    expect(getEffectiveActions(doc, PRINCIPAL_A)).toStrictEqual(['s3:GetObject']);
  });

  it('returns no effective actions for a principal not mentioned by the policy', () => {
    expect(getEffectiveActions(grantReadToPrincipalA, PRINCIPAL_B)).toStrictEqual([]);
  });

  it('returns no effective actions when the policy has only Deny statements for the principal', () => {
    const doc = policy(grant(members(PRINCIPAL_A), ['s3:GetObject'], 'Deny'));
    expect(getEffectiveActions(doc, PRINCIPAL_A)).toStrictEqual([]);
  });

  it('does not read a "*" argument as matching every listed principal', () => {
    // A statement listing PRINCIPAL_A would apply if "*" meant "anyone".
    expect(getEffectiveActions(grantReadToPrincipalA, '*')).toStrictEqual([]);
  });

  it('applies an Allow statement with Principal "*" to a "*" argument', () => {
    // "*" stands for a member the policy does not list; hasNewRetentionGrants relies on it.
    const doc = policy(grant('*', ['s3:GetObject']));
    expect(getEffectiveActions(doc, '*')).toStrictEqual(['s3:GetObject']);
  });
});

describe('hasNewRetentionGrants', () => {
  const grantAllActionsToOwners = policy({
    Sid: 'owners',
    Effect: 'Allow',
    Principal: members(PRINCIPAL_C),
    Action: ['s3:*'],
    Resource: BOTH_ARNS,
  });
  const grantRetentionToEveryone = policy({
    Effect: 'Allow',
    Principal: '*',
    Action: [...RETENTION_WRITE_ACTIONS],
    Resource: [OBJECTS_ARN],
  });
  const grantRetentionToOwnersAndPrincipalB = policy(...grantAllActionsToOwners.Statement, {
    Effect: 'Allow',
    Principal: members(PRINCIPAL_B),
    Action: ['s3:PutObjectRetention'],
    Resource: [OBJECTS_ARN],
  });

  it.each(RETENTION_WRITE_ACTIONS)('returns true when a new policy allows %s', (action) => {
    const next = policy({
      Effect: 'Allow',
      Principal: members(PRINCIPAL_A),
      Action: [action],
      Resource: [OBJECTS_ARN],
    });
    expect(hasNewRetentionGrants(null, next)).toBe(true);
  });

  it('returns true when a new policy allows s3:*', () => {
    expect(hasNewRetentionGrants(null, grantAllActionsToOwners)).toBe(true);
  });

  it('ignores Deny statements', () => {
    const next = policy({
      Effect: 'Deny',
      Principal: '*',
      Action: [...RETENTION_WRITE_ACTIONS],
      Resource: [OBJECTS_ARN],
    });
    expect(hasNewRetentionGrants(null, next)).toBe(false);
  });

  it('ignores Allow statements where Action does not cover the retention writes', () => {
    expect(hasNewRetentionGrants(null, grantReadToPrincipalA)).toBe(false);
  });

  it('returns false when the stored policy already grants the retention writes', () => {
    const next = policy(...grantAllActionsToOwners.Statement, ...grantReadToPrincipalA.Statement);
    expect(hasNewRetentionGrants(grantAllActionsToOwners, next)).toBe(false);
  });

  it('returns true when the new policy adds a retention grant to a new principal', () => {
    expect(
      hasNewRetentionGrants(grantAllActionsToOwners, grantRetentionToOwnersAndPrincipalB),
    ).toBe(true);
  });

  it('returns false when a grant to everyone is narrowed down', () => {
    expect(
      hasNewRetentionGrants(grantRetentionToEveryone, grantRetentionToOwnersAndPrincipalB),
    ).toBe(false);
  });

  it('returns true when a policy is widened to a grant to everyone', () => {
    expect(hasNewRetentionGrants(grantAllActionsToOwners, grantRetentionToEveryone)).toBe(true);
  });

  it('returns true when the new policy removed the deny statement that was overriding an allow statement', () => {
    const allow: PolicyStatement = {
      Effect: 'Allow',
      Principal: members(PRINCIPAL_A),
      Action: ['s3:PutObjectRetention'],
      Resource: [OBJECTS_ARN],
    };
    const deny: PolicyStatement = { ...allow, Effect: 'Deny' };
    // Deny wins at the storage system, so the policy grants nothing until the
    // deny goes; removing it is the grant.
    const masked = policy(allow, deny);

    expect(hasNewRetentionGrants(masked, policy(allow))).toBe(true);
  });
});

describe('getCreatorBucketPolicy', () => {
  it('names only the creator, with every action but the retention writes', () => {
    expect(getCreatorBucketPolicy({ creatorId: PRINCIPAL_C, bucketName: BUCKET })).toStrictEqual({
      Version: POLICY_VERSION,
      Statement: [
        {
          Sid: 'creator',
          Effect: 'Allow',
          Principal: members(PRINCIPAL_C),
          Action: CREATOR_ACTIONS,
          Resource: BOTH_ARNS,
        },
      ],
    });
  });

  it('returns a policy the schema accepts', () => {
    expect(
      BucketPolicySchema.safeParse(
        getCreatorBucketPolicy({ creatorId: PRINCIPAL_C, bucketName: BUCKET }),
      ),
    ).toMatchObject({ success: true });
  });
});
