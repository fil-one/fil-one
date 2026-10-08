import { describe, it, expect } from 'vitest';
import {
  BucketPolicySchema,
  POLICY_ACTIONS,
  POLICY_ACTION_LABELS,
  POLICY_ACTION_GROUPS,
  PutBucketPolicyRequestSchema,
  RETENTION_WRITE_ACTIONS,
  ROSTER_ADMIN_ACTIONS,
  ROSTER_ADMINS_SID,
  ROSTER_CREATOR_SID,
  ROSTER_OWNERS_SID,
  getDefaultBucketPolicy,
  getEffectiveActions,
  getPolicyActionsInGroup,
  hasNewRetentionGrants,
  isRosterSid,
  replaceRosterStatements,
} from './bucket-policies.ts';
import type { BucketPolicy, PolicyStatement } from './bucket-policies.ts';

// Arbitrary console user ids. The schema accepts only UUIDs.
const PRINCIPAL_A = '00000000-0000-4000-8000-00000000000a';
const PRINCIPAL_B = '00000000-0000-4000-8000-00000000000b';
const PRINCIPAL_C = '00000000-0000-4000-8000-00000000000c';

const grantReadToPrincipalA: BucketPolicy = {
  Statement: [
    { Effect: 'Allow', Principal: [PRINCIPAL_A], Action: ['s3:GetObject', 's3:ListBucket'] },
  ],
};

describe('the policy vocabulary', () => {
  it.each(['s3:CreateBucket', 's3:DeleteBucket', 's3:ListAllMyBuckets'])(
    'does not offer the bucket-level action %s',
    (action) => {
      expect(POLICY_ACTIONS as readonly string[]).not.toContain(action);
    },
  );

  it('offers fourteen actions', () => {
    expect(POLICY_ACTIONS).toHaveLength(14);
  });

  it('labels every action', () => {
    expect(Object.keys(POLICY_ACTION_LABELS).sort()).toStrictEqual([...POLICY_ACTIONS].sort());
  });

  it('places every action in exactly one display group', () => {
    const grouped = POLICY_ACTION_GROUPS.flatMap(getPolicyActionsInGroup);
    expect(grouped.sort()).toStrictEqual([...POLICY_ACTIONS].sort());
  });

  it('puts the retention and legal-hold actions in the protect group', () => {
    expect(getPolicyActionsInGroup('protect')).toStrictEqual([
      's3:GetObjectRetention',
      's3:GetObjectLegalHold',
      's3:PutObjectRetention',
      's3:PutObjectLegalHold',
    ]);
  });

  it('gives the roster Admin statement every action but the two retention writes', () => {
    expect(ROSTER_ADMIN_ACTIONS).toStrictEqual([
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
      's3:DeleteObject',
      's3:DeleteObjectVersion',
    ]);
  });
});

describe('BucketPolicySchema', () => {
  const validStatement = {
    Effect: 'Allow',
    Principal: [PRINCIPAL_A],
    Action: ['s3:GetObject'],
  };
  const withStatement = (changes: Record<string, unknown>) => ({
    Statement: [{ ...validStatement, ...changes }],
  });

  it.each([
    {
      name: 'the shape the storage system stores',
      input: {
        Statement: [
          {
            Sid: 'owners',
            Effect: 'Allow',
            Principal: [PRINCIPAL_A, PRINCIPAL_B],
            Action: ['s3:*'],
          },
          { Effect: 'Deny', Principal: '*', Action: ['s3:PutObjectRetention'] },
        ],
      },
    },
    { name: 'a principal named by UUID', input: withStatement({}) },
    { name: 'the wildcard principal as the bare string', input: withStatement({ Principal: '*' }) },
  ])('accepts $name', ({ input }) => {
    expect(BucketPolicySchema.safeParse(input)).toMatchObject({ success: true });
  });

  it('keeps each principal once, in the order first given', () => {
    const parsed = BucketPolicySchema.parse(
      withStatement({ Principal: [PRINCIPAL_B, PRINCIPAL_A, PRINCIPAL_B] }),
    );
    expect(parsed).toStrictEqual(withStatement({ Principal: [PRINCIPAL_B, PRINCIPAL_A] }));
  });

  it.each([
    {
      name: 'a statement field it does not define',
      // not part of the statement shape
      input: withStatement({ resource: 'photos' }),
      issue: { code: 'unrecognized_keys', keys: ['resource'], path: ['Statement', 0] },
    },
    {
      name: 'a document field it does not define',
      // misspelled, should have been Version
      input: { ...withStatement({}), version: '2012-10-17' },
      issue: { code: 'unrecognized_keys', keys: ['version'], path: [] },
    },
    {
      name: 'the wildcard principal inside a list',
      input: withStatement({ Principal: ['*'] }),
      issue: {
        code: 'invalid_union',
        path: ['Statement', 0, 'Principal'],
        errors: expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({
              code: 'custom',
              message: 'Name every member with the bare "*" string, never inside a list',
            }),
          ]),
        ]),
      },
    },
    {
      name: 'a principal id that is not a UUID',
      input: withStatement({ Principal: ['alice'] }),
      issue: {
        code: 'invalid_union',
        path: ['Statement', 0, 'Principal'],
        errors: expect.arrayContaining([
          [expect.objectContaining({ code: 'invalid_format', format: 'uuid', path: [0] })],
        ]),
      },
    },
    {
      name: 'an empty statement list',
      input: { Statement: [] },
      issue: { code: 'too_small', minimum: 1, path: ['Statement'] },
    },
    {
      name: 'an empty principal list',
      input: withStatement({ Principal: [] }),
      issue: {
        code: 'invalid_union',
        path: ['Statement', 0, 'Principal'],
        errors: expect.arrayContaining([
          [expect.objectContaining({ code: 'too_small', minimum: 1 })],
        ]),
      },
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

describe('getEffectiveActions', () => {
  it('returns the actions of Allow statements that list the principal, sorted', () => {
    const policy: BucketPolicy = {
      Statement: [
        { Effect: 'Allow', Principal: [PRINCIPAL_A], Action: ['s3:PutObject', 's3:GetObject'] },
      ],
    };
    expect(getEffectiveActions(policy, PRINCIPAL_A)).toStrictEqual([
      's3:GetObject',
      's3:PutObject',
    ]);
  });

  it('expands the s3:* action to every action', () => {
    const policy: BucketPolicy = {
      Statement: [{ Effect: 'Allow', Principal: [PRINCIPAL_A], Action: ['s3:*'] }],
    };
    expect(getEffectiveActions(policy, PRINCIPAL_A)).toStrictEqual([...POLICY_ACTIONS].sort());
  });

  it('removes the actions a Deny statement covers', () => {
    const policy: BucketPolicy = {
      Statement: [
        ...grantReadToPrincipalA.Statement,
        { Effect: 'Deny', Principal: [PRINCIPAL_A], Action: ['s3:ListBucket'] },
      ],
    };
    expect(getEffectiveActions(policy, PRINCIPAL_A)).toStrictEqual(['s3:GetObject']);
  });

  it('applies an Allow statement with Principal "*" to a principal it does not list', () => {
    const policy: BucketPolicy = {
      Statement: [{ Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'] }],
    };
    expect(getEffectiveActions(policy, PRINCIPAL_A)).toStrictEqual(['s3:GetObject']);
  });

  it('applies a Deny statement with Principal "*" to a principal it does not list', () => {
    const policy: BucketPolicy = {
      Statement: [
        ...grantReadToPrincipalA.Statement,
        { Effect: 'Deny', Principal: '*', Action: ['s3:ListBucket'] },
      ],
    };
    expect(getEffectiveActions(policy, PRINCIPAL_A)).toStrictEqual(['s3:GetObject']);
  });

  it('returns no effective actions for a principal not mentioned by the policy', () => {
    expect(getEffectiveActions(grantReadToPrincipalA, PRINCIPAL_B)).toStrictEqual([]);
  });

  it('returns no effective actions when the policy has only Deny statements for the principal', () => {
    const policy: BucketPolicy = {
      Statement: [{ Effect: 'Deny', Principal: [PRINCIPAL_A], Action: ['s3:GetObject'] }],
    };
    expect(getEffectiveActions(policy, PRINCIPAL_A)).toStrictEqual([]);
  });

  it('does not read a "*" argument as matching every listed principal', () => {
    // A statement listing PRINCIPAL_A would apply if "*" meant "anyone".
    expect(getEffectiveActions(grantReadToPrincipalA, '*')).toStrictEqual([]);
  });

  it('applies an Allow statement with Principal "*" to a "*" argument', () => {
    // "*" stands for a member the policy does not list; hasNewRetentionGrants relies on it.
    const policy: BucketPolicy = {
      Statement: [{ Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'] }],
    };
    expect(getEffectiveActions(policy, '*')).toStrictEqual(['s3:GetObject']);
  });
});

describe('hasNewRetentionGrants', () => {
  const grantAllActionsToOwners: BucketPolicy = {
    Statement: [
      { Sid: ROSTER_OWNERS_SID, Effect: 'Allow', Principal: [PRINCIPAL_C], Action: ['s3:*'] },
    ],
  };
  const grantRetentionToEveryone: BucketPolicy = {
    Statement: [{ Effect: 'Allow', Principal: '*', Action: [...RETENTION_WRITE_ACTIONS] }],
  };
  const grantRetentionToOwnersAndPrincipalB: BucketPolicy = {
    Statement: [
      ...grantAllActionsToOwners.Statement,
      { Effect: 'Allow', Principal: [PRINCIPAL_B], Action: ['s3:PutObjectRetention'] },
    ],
  };

  it.each(RETENTION_WRITE_ACTIONS)('returns true when a new policy allows %s', (action) => {
    const next: BucketPolicy = {
      Statement: [{ Effect: 'Allow', Principal: [PRINCIPAL_A], Action: [action] }],
    };
    expect(hasNewRetentionGrants(null, next)).toBe(true);
  });

  it('returns true when a new policy allows s3:*', () => {
    expect(hasNewRetentionGrants(null, grantAllActionsToOwners)).toBe(true);
  });

  it('ignores Deny statements', () => {
    const next: BucketPolicy = {
      Statement: [{ Effect: 'Deny', Principal: '*', Action: [...RETENTION_WRITE_ACTIONS] }],
    };
    expect(hasNewRetentionGrants(null, next)).toBe(false);
  });

  it('ignores Allow statements where Action does not cover the retention writes', () => {
    expect(hasNewRetentionGrants(null, grantReadToPrincipalA)).toBe(false);
  });

  it('returns false when the stored policy already grants the retention writes', () => {
    const next: BucketPolicy = {
      Statement: [...grantAllActionsToOwners.Statement, ...grantReadToPrincipalA.Statement],
    };
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
      Principal: [PRINCIPAL_A],
      Action: ['s3:PutObjectRetention'],
    };
    const deny: PolicyStatement = { ...allow, Effect: 'Deny' };
    // Deny wins at the storage system, so the policy grants nothing until the
    // deny goes; removing it is the grant.
    const masked: BucketPolicy = { Statement: [allow, deny] };

    expect(hasNewRetentionGrants(masked, { Statement: [allow] })).toBe(true);
  });
});

describe('isRosterSid', () => {
  it.each([ROSTER_OWNERS_SID, ROSTER_ADMINS_SID, ROSTER_CREATOR_SID])(
    'returns true for %j',
    (sid) => {
      expect(isRosterSid(sid)).toBe(true);
    },
  );

  it.each([undefined, '', 'filone-owner', 'Filone-Owners', 'filone-members'])(
    'returns false for %j',
    (sid) => {
      expect(isRosterSid(sid)).toBe(false);
    },
  );
});

describe('getDefaultBucketPolicy', () => {
  it('gives Owners every action, Admins the Admin actions, and a Member creator a statement of their own', () => {
    const creator = getDefaultBucketPolicy({
      owners: [PRINCIPAL_A],
      admins: [PRINCIPAL_B],
      creatorId: PRINCIPAL_C,
    });
    expect(creator).toStrictEqual({
      Statement: [
        { Sid: ROSTER_OWNERS_SID, Effect: 'Allow', Principal: [PRINCIPAL_A], Action: ['s3:*'] },
        {
          Sid: ROSTER_ADMINS_SID,
          Effect: 'Allow',
          Principal: [PRINCIPAL_B],
          Action: ROSTER_ADMIN_ACTIONS,
        },
        {
          Sid: ROSTER_CREATOR_SID,
          Effect: 'Allow',
          Principal: [PRINCIPAL_C],
          Action: ROSTER_ADMIN_ACTIONS,
        },
      ],
    });
  });

  it('returns a policy the schema accepts', () => {
    const creator = getDefaultBucketPolicy({
      owners: [PRINCIPAL_A],
      admins: [PRINCIPAL_B],
      creatorId: PRINCIPAL_C,
    });
    expect(BucketPolicySchema.safeParse(creator)).toMatchObject({ success: true });
  });

  it('gives an Owner creator no second statement', () => {
    const creator = getDefaultBucketPolicy({
      owners: [PRINCIPAL_A],
      admins: [PRINCIPAL_B],
      creatorId: PRINCIPAL_A,
    });
    expect(creator.Statement.map((s) => s.Sid)).toStrictEqual([
      ROSTER_OWNERS_SID,
      ROSTER_ADMINS_SID,
    ]);
  });

  it('gives an Admin creator no second statement', () => {
    const creator = getDefaultBucketPolicy({
      owners: [PRINCIPAL_A],
      admins: [PRINCIPAL_B],
      creatorId: PRINCIPAL_B,
    });
    expect(creator.Statement.map((s) => s.Sid)).toStrictEqual([
      ROSTER_OWNERS_SID,
      ROSTER_ADMINS_SID,
    ]);
  });

  it.each([
    {
      name: 'the Owners statement when there are no Owners',
      roster: { owners: [], admins: [PRINCIPAL_B], creatorId: PRINCIPAL_B },
      sids: [ROSTER_ADMINS_SID],
    },
    {
      name: 'the Admins statement when there are no Admins',
      roster: { owners: [PRINCIPAL_A], admins: [], creatorId: PRINCIPAL_A },
      sids: [ROSTER_OWNERS_SID],
    },
    {
      name: 'the Admins statement when every Admin is also an Owner',
      roster: { owners: [PRINCIPAL_A], admins: [PRINCIPAL_A], creatorId: PRINCIPAL_A },
      sids: [ROSTER_OWNERS_SID],
    },
  ])('drops $name', ({ roster, sids }) => {
    const creator = getDefaultBucketPolicy(roster);
    expect(creator.Statement.map((s) => s.Sid)).toStrictEqual(sids);
  });
});

describe('replaceRosterStatements', () => {
  it('keeps the creator statement when the roster is rewritten', () => {
    const created = getDefaultBucketPolicy({
      owners: [PRINCIPAL_A],
      admins: [],
      creatorId: PRINCIPAL_C,
    });
    const next = replaceRosterStatements(created, { owners: [PRINCIPAL_B], admins: [PRINCIPAL_A] });
    expect(next?.Statement.map((s) => [s.Sid, s.Principal])).toStrictEqual([
      [ROSTER_OWNERS_SID, [PRINCIPAL_B]],
      [ROSTER_ADMINS_SID, [PRINCIPAL_A]],
      [ROSTER_CREATOR_SID, [PRINCIPAL_C]],
    ]);
  });

  it('replaces only the roster statements and keeps every other statement', () => {
    const team: PolicyStatement = {
      Sid: 'team',
      Effect: 'Allow',
      Principal: [PRINCIPAL_C],
      Action: ['s3:GetObject'],
    };
    const existing: BucketPolicy = {
      Statement: [
        { Sid: ROSTER_OWNERS_SID, Effect: 'Allow', Principal: [PRINCIPAL_A], Action: ['s3:*'] },
        team,
      ],
    };
    expect(replaceRosterStatements(existing, { owners: [PRINCIPAL_B], admins: [] })).toStrictEqual({
      Statement: [
        { Sid: ROSTER_OWNERS_SID, Effect: 'Allow', Principal: [PRINCIPAL_B], Action: ['s3:*'] },
        team,
      ],
    });
  });

  it('returns null when there is no policy and the roster is empty', () => {
    expect(replaceRosterStatements(null, { owners: [], admins: [] })).toBeNull();
  });

  it('returns null when the policy holds only roster statements and the roster is empty', () => {
    const existing: BucketPolicy = {
      Statement: [
        { Sid: ROSTER_OWNERS_SID, Effect: 'Allow', Principal: [PRINCIPAL_A], Action: ['s3:*'] },
      ],
    };
    expect(replaceRosterStatements(existing, { owners: [], admins: [] })).toBeNull();
  });
});
