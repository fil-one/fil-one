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
  addsRetentionGrants,
  defaultBucketPolicy,
  effectiveActions,
  isRosterSid,
  policyActionsInGroup,
  withRosterStatements,
} from './bucket-policies.ts';
import type { BucketPolicy, PolicyStatement } from './bucket-policies.ts';

// Console user ids, the only principal ids the schema accepts.
const PRINCIPAL_A = '00000000-0000-4000-8000-00000000000a';
const PRINCIPAL_B = '00000000-0000-4000-8000-00000000000b';
const PRINCIPAL_C = '00000000-0000-4000-8000-00000000000c';

const read: BucketPolicy = {
  Statement: [
    { Effect: 'Allow', Principal: [PRINCIPAL_A], Action: ['s3:GetObject', 's3:ListBucket'] },
  ],
};

describe('the policy vocabulary', () => {
  it('excludes the three bucket-level actions the RFC keeps for service keys', () => {
    const actions: readonly string[] = POLICY_ACTIONS;
    expect(actions).not.toContain('s3:CreateBucket');
    expect(actions).not.toContain('s3:DeleteBucket');
    expect(actions).not.toContain('s3:ListAllMyBuckets');
    expect(POLICY_ACTIONS).toHaveLength(14);
  });

  it('labels every action and places each in one display group', () => {
    expect(Object.keys(POLICY_ACTION_LABELS).sort()).toStrictEqual([...POLICY_ACTIONS].sort());
    const grouped = POLICY_ACTION_GROUPS.flatMap(policyActionsInGroup);
    expect([...grouped].sort()).toStrictEqual([...POLICY_ACTIONS].sort());
  });

  it('gives the roster Admin statement every action but the two retention writes', () => {
    expect(ROSTER_ADMIN_ACTIONS).toHaveLength(POLICY_ACTIONS.length - 2);
    for (const action of RETENTION_WRITE_ACTIONS) {
      expect(ROSTER_ADMIN_ACTIONS).not.toContain(action);
    }
  });
});

describe('BucketPolicySchema', () => {
  it('accepts the shape the storage system stores', () => {
    const result = BucketPolicySchema.safeParse({
      Statement: [
        { Sid: 'owners', Effect: 'Allow', Principal: [PRINCIPAL_A, PRINCIPAL_B], Action: ['s3:*'] },
        { Effect: 'Deny', Principal: '*', Action: ['s3:PutObjectRetention'] },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('names each member once, in the order first given', () => {
    const parsed = BucketPolicySchema.parse({
      Statement: [
        {
          Effect: 'Allow',
          Principal: [PRINCIPAL_B, PRINCIPAL_A, PRINCIPAL_B],
          Action: ['s3:GetObject'],
        },
      ],
    });
    expect(parsed).toEqual({
      Statement: [
        { Effect: 'Allow', Principal: [PRINCIPAL_B, PRINCIPAL_A], Action: ['s3:GetObject'] },
      ],
    });
  });

  it('refuses a field it does not define, as the storage system does', () => {
    expect(
      BucketPolicySchema.safeParse({
        Statement: [
          {
            Effect: 'Allow',
            Principal: [PRINCIPAL_A],
            Action: ['s3:GetObject'],
            resource: 'photos',
          },
        ],
      }).success,
    ).toBe(false);
    expect(BucketPolicySchema.safeParse({ Statement: [], version: '2012-10-17' }).success).toBe(
      false,
    );
  });

  it('spells the wildcard principal one way: the bare string, never inside a list', () => {
    expect(
      BucketPolicySchema.safeParse({
        Statement: [{ Effect: 'Allow', Principal: ['*'], Action: ['s3:GetObject'] }],
      }).success,
    ).toBe(false);
    expect(
      BucketPolicySchema.safeParse({
        Statement: [{ Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'] }],
      }).success,
    ).toBe(true);
  });

  it('names a member by the UUID the console mints as its user id', () => {
    const naming = (principal: string[]) =>
      BucketPolicySchema.safeParse({
        Statement: [{ Effect: 'Allow', Principal: principal, Action: ['s3:GetObject'] }],
      }).success;
    expect(naming([PRINCIPAL_A])).toBe(true);
    expect(naming(['alice'])).toBe(false);
    expect(naming(['auth0|alice'])).toBe(false);
  });

  it('refuses an empty document, an empty principal list, and an empty action list', () => {
    expect(BucketPolicySchema.safeParse({ Statement: [] }).success).toBe(false);
    expect(
      BucketPolicySchema.safeParse({
        Statement: [{ Effect: 'Allow', Principal: [], Action: ['s3:GetObject'] }],
      }).success,
    ).toBe(false);
    expect(
      BucketPolicySchema.safeParse({
        Statement: [{ Effect: 'Allow', Principal: [PRINCIPAL_A], Action: [] }],
      }).success,
    ).toBe(false);
  });

  it('refuses an action outside the vocabulary and an effect outside Allow/Deny', () => {
    expect(
      BucketPolicySchema.safeParse({
        Statement: [{ Effect: 'Allow', Principal: [PRINCIPAL_A], Action: ['s3:CreateBucket'] }],
      }).success,
    ).toBe(false);
    expect(
      BucketPolicySchema.safeParse({
        Statement: [{ Effect: 'allow', Principal: [PRINCIPAL_A], Action: ['s3:GetObject'] }],
      }).success,
    ).toBe(false);
  });

  it('refuses an etag in the PUT body, which travels in If-Match', () => {
    expect(PutBucketPolicyRequestSchema.safeParse({ policy: read }).success).toBe(true);
    expect(PutBucketPolicyRequestSchema.safeParse({ policy: read, etag: '"abc"' }).success).toBe(
      false,
    );
  });
});

describe('effectiveActions', () => {
  it('is the allow union minus the deny union, sorted, with deny winning', () => {
    const policy: BucketPolicy = {
      Statement: [
        { Effect: 'Allow', Principal: ['alice'], Action: ['s3:*'] },
        {
          Effect: 'Deny',
          Principal: '*',
          Action: ['s3:PutObjectRetention', 's3:PutObjectLegalHold'],
        },
        { Effect: 'Deny', Principal: ['alice'], Action: ['s3:DeleteObject'] },
      ],
    };
    const actions = effectiveActions(policy, 'alice');
    expect(actions).toStrictEqual([...actions].sort());
    expect(actions).toHaveLength(POLICY_ACTIONS.length - 3);
    expect(actions).not.toContain('s3:DeleteObject');
    expect(actions).not.toContain('s3:PutObjectRetention');
  });

  it('gives a principal nobody names nothing, and a deny alone nothing', () => {
    expect(effectiveActions(read, 'bob')).toStrictEqual([]);
    expect(
      effectiveActions(
        { Statement: [{ Effect: 'Deny', Principal: ['bob'], Action: ['s3:GetObject'] }] },
        'bob',
      ),
    ).toStrictEqual([]);
  });

  it('never treats the wildcard as a principal of its own', () => {
    expect(
      effectiveActions(
        { Statement: [{ Effect: 'Allow', Principal: ['a'], Action: ['s3:*'] }] },
        '*',
      ),
    ).toStrictEqual([]);
  });
});

describe('addsRetentionGrants', () => {
  const ownersAll: BucketPolicy = {
    Statement: [{ Sid: ROSTER_OWNERS_SID, Effect: 'Allow', Principal: ['o'], Action: ['s3:*'] }],
  };

  it('counts an allow of either retention write, or the wildcard action, as a grant', () => {
    expect(
      addsRetentionGrants(null, {
        Statement: [{ Effect: 'Allow', Principal: ['a'], Action: ['s3:PutObjectLegalHold'] }],
      }),
    ).toBe(true);
    expect(addsRetentionGrants(null, ownersAll)).toBe(true);
  });

  it('does not count a deny of the pair, nor an allow without it', () => {
    expect(
      addsRetentionGrants(null, {
        Statement: [{ Effect: 'Deny', Principal: '*', Action: [...RETENTION_WRITE_ACTIONS] }],
      }),
    ).toBe(false);
    expect(addsRetentionGrants(null, read)).toBe(false);
  });

  it('ignores a grant the stored document already makes, so editing around it needs no Owner', () => {
    const edited: BucketPolicy = {
      Statement: [...ownersAll.Statement, ...read.Statement],
    };
    expect(addsRetentionGrants(ownersAll, edited)).toBe(false);
  });

  it('catches a grant to a new principal, and treats a grant to everyone as covering all', () => {
    const widened: BucketPolicy = {
      Statement: [
        ...ownersAll.Statement,
        { Effect: 'Allow', Principal: ['b'], Action: ['s3:PutObjectRetention'] },
      ],
    };
    expect(addsRetentionGrants(ownersAll, widened)).toBe(true);

    const everyone: BucketPolicy = {
      Statement: [{ Effect: 'Allow', Principal: '*', Action: [...RETENTION_WRITE_ACTIONS] }],
    };
    expect(addsRetentionGrants(everyone, widened)).toBe(false);
    expect(addsRetentionGrants(ownersAll, everyone)).toBe(true);
  });

  it('counts removing a deny that masked an allow as a new grant', () => {
    // Deny wins at the storage system, so the allow grants nothing until the
    // deny goes; removing it is the grant.
    const allow: PolicyStatement = {
      Effect: 'Allow',
      Principal: ['a'],
      Action: ['s3:PutObjectRetention'],
    };
    const masked: BucketPolicy = {
      Statement: [allow, { Effect: 'Deny', Principal: ['a'], Action: ['s3:PutObjectRetention'] }],
    };
    expect(addsRetentionGrants(masked, { Statement: [allow] })).toBe(true);
  });

  it('reads a principal id containing a pipe whole, as Auth0 subs are spelled', () => {
    const everyone: BucketPolicy = {
      Statement: [{ Effect: 'Allow', Principal: '*', Action: ['s3:PutObjectRetention'] }],
    };
    const redundant: BucketPolicy = {
      Statement: [
        ...everyone.Statement,
        { Effect: 'Allow', Principal: ['auth0|alice'], Action: ['s3:PutObjectRetention'] },
      ],
    };
    expect(addsRetentionGrants(everyone, redundant)).toBe(false);
  });
});

describe('the roster statements', () => {
  it('reserves exactly the three labels the console writes', () => {
    for (const sid of [ROSTER_OWNERS_SID, ROSTER_ADMINS_SID, ROSTER_CREATOR_SID]) {
      expect(isRosterSid(sid)).toBe(true);
    }
    for (const sid of [undefined, '', 'filone-owner', 'Filone-Owners', 'filone-members']) {
      expect(isRosterSid(sid)).toBe(false);
    }
  });

  it('names Owners with every action, Admins with the Admin set, and a Member creator apart', () => {
    const policy = defaultBucketPolicy({
      owners: [PRINCIPAL_A],
      admins: [PRINCIPAL_B],
      creatorId: PRINCIPAL_C,
    });
    expect(policy.Statement).toStrictEqual([
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
    ]);
    expect(BucketPolicySchema.safeParse(policy).success).toBe(true);
  });

  it('gives an Owner or Admin creator no second statement, and drops a statement nobody would be in', () => {
    const owner = defaultBucketPolicy({ owners: ['o1'], admins: [], creatorId: 'o1' });
    expect(owner.Statement.map((s) => s.Sid)).toStrictEqual([ROSTER_OWNERS_SID]);
    const admin = defaultBucketPolicy({ owners: ['o1'], admins: ['a1'], creatorId: 'a1' });
    expect(admin.Statement.map((s) => s.Sid)).toStrictEqual([ROSTER_OWNERS_SID, ROSTER_ADMINS_SID]);
  });

  it('keeps the creator statement when the roster is rewritten', () => {
    const created = defaultBucketPolicy({ owners: ['o1'], admins: [], creatorId: 'm1' });
    const next = withRosterStatements(created, { owners: ['o2'], admins: ['o1'] });
    expect(next?.Statement.map((s) => [s.Sid, s.Principal])).toStrictEqual([
      [ROSTER_OWNERS_SID, ['o2']],
      [ROSTER_ADMINS_SID, ['o1']],
      [ROSTER_CREATOR_SID, ['m1']],
    ]);
  });

  it('replaces only the roster statements and keeps every other statement', () => {
    const existing: BucketPolicy = {
      Statement: [
        { Sid: ROSTER_OWNERS_SID, Effect: 'Allow', Principal: ['old-owner'], Action: ['s3:*'] },
        { Sid: 'team', Effect: 'Allow', Principal: ['m1'], Action: ['s3:GetObject'] },
      ],
    };
    const next = withRosterStatements(existing, { owners: ['new-owner'], admins: ['a1'] });
    expect(next?.Statement.map((s) => s.Sid)).toStrictEqual([
      ROSTER_OWNERS_SID,
      ROSTER_ADMINS_SID,
      'team',
    ]);
    expect(next?.Statement[0].Principal).toStrictEqual(['new-owner']);
  });

  it('answers null when nothing would be left, which means delete the policy', () => {
    expect(withRosterStatements(null, { owners: [], admins: [] })).toBeNull();
    expect(
      withRosterStatements(
        {
          Statement: [
            { Sid: ROSTER_OWNERS_SID, Effect: 'Allow', Principal: ['o'], Action: ['s3:*'] },
          ],
        },
        { owners: [], admins: [] },
      ),
    ).toBeNull();
  });
});
