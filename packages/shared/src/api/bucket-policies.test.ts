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
  policyActionsInGroup,
  withRosterStatements,
} from './bucket-policies.ts';
import type { BucketPolicy } from './bucket-policies.ts';

const read: BucketPolicy = {
  statement: [{ effect: 'allow', principal: ['alice'], action: ['s3:GetObject', 's3:ListBucket'] }],
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
      statement: [
        { sid: 'owners', effect: 'allow', principal: ['a', 'b'], action: ['s3:*'] },
        { effect: 'deny', principal: '*', action: ['s3:PutObjectRetention'] },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('names each member once, in the order first given', () => {
    const parsed = BucketPolicySchema.parse({
      statement: [
        { effect: 'allow', principal: ['bob', 'alice', 'bob'], action: ['s3:GetObject'] },
      ],
    });
    expect(parsed).toEqual({
      statement: [{ effect: 'allow', principal: ['bob', 'alice'], action: ['s3:GetObject'] }],
    });
  });

  it('refuses a field it does not define, as the storage system does', () => {
    expect(
      BucketPolicySchema.safeParse({
        statement: [
          { effect: 'allow', principal: ['a'], action: ['s3:GetObject'], resource: 'photos' },
        ],
      }).success,
    ).toBe(false);
    expect(BucketPolicySchema.safeParse({ statement: [], version: '2012-10-17' }).success).toBe(
      false,
    );
  });

  it('spells the wildcard principal one way: the bare string, never inside a list', () => {
    expect(
      BucketPolicySchema.safeParse({
        statement: [{ effect: 'allow', principal: ['*'], action: ['s3:GetObject'] }],
      }).success,
    ).toBe(false);
    expect(
      BucketPolicySchema.safeParse({
        statement: [{ effect: 'allow', principal: '*', action: ['s3:GetObject'] }],
      }).success,
    ).toBe(true);
  });

  it('refuses an empty document, an empty principal list, and an empty action list', () => {
    expect(BucketPolicySchema.safeParse({ statement: [] }).success).toBe(false);
    expect(
      BucketPolicySchema.safeParse({
        statement: [{ effect: 'allow', principal: [], action: ['s3:GetObject'] }],
      }).success,
    ).toBe(false);
    expect(
      BucketPolicySchema.safeParse({
        statement: [{ effect: 'allow', principal: ['a'], action: [] }],
      }).success,
    ).toBe(false);
  });

  it('refuses an action outside the vocabulary and an effect outside allow/deny', () => {
    expect(
      BucketPolicySchema.safeParse({
        statement: [{ effect: 'allow', principal: ['a'], action: ['s3:CreateBucket'] }],
      }).success,
    ).toBe(false);
    expect(
      BucketPolicySchema.safeParse({
        statement: [{ effect: 'Allow', principal: ['a'], action: ['s3:GetObject'] }],
      }).success,
    ).toBe(false);
  });

  it('lets the PUT request omit the etag only as a whole field', () => {
    expect(PutBucketPolicyRequestSchema.safeParse({ policy: read }).success).toBe(true);
    expect(PutBucketPolicyRequestSchema.safeParse({ policy: read, etag: '"abc"' }).success).toBe(
      true,
    );
    expect(PutBucketPolicyRequestSchema.safeParse({ policy: read, etag: '' }).success).toBe(false);
  });
});

describe('effectiveActions', () => {
  it('is the allow union minus the deny union, sorted, with deny winning', () => {
    const policy: BucketPolicy = {
      statement: [
        { effect: 'allow', principal: ['alice'], action: ['s3:*'] },
        {
          effect: 'deny',
          principal: '*',
          action: ['s3:PutObjectRetention', 's3:PutObjectLegalHold'],
        },
        { effect: 'deny', principal: ['alice'], action: ['s3:DeleteObject'] },
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
        { statement: [{ effect: 'deny', principal: ['bob'], action: ['s3:GetObject'] }] },
        'bob',
      ),
    ).toStrictEqual([]);
  });

  it('never treats the wildcard as a principal of its own', () => {
    expect(
      effectiveActions(
        { statement: [{ effect: 'allow', principal: ['a'], action: ['s3:*'] }] },
        '*',
      ),
    ).toStrictEqual([]);
  });
});

describe('addsRetentionGrants', () => {
  const ownersAll: BucketPolicy = {
    statement: [{ sid: ROSTER_OWNERS_SID, effect: 'allow', principal: ['o'], action: ['s3:*'] }],
  };

  it('counts an allow of either retention write, or the wildcard action, as a grant', () => {
    expect(
      addsRetentionGrants(null, {
        statement: [{ effect: 'allow', principal: ['a'], action: ['s3:PutObjectLegalHold'] }],
      }),
    ).toBe(true);
    expect(addsRetentionGrants(null, ownersAll)).toBe(true);
  });

  it('does not count a deny of the pair, nor an allow without it', () => {
    expect(
      addsRetentionGrants(null, {
        statement: [{ effect: 'deny', principal: '*', action: [...RETENTION_WRITE_ACTIONS] }],
      }),
    ).toBe(false);
    expect(addsRetentionGrants(null, read)).toBe(false);
  });

  it('ignores a grant the stored document already makes, so editing around it needs no Owner', () => {
    const edited: BucketPolicy = {
      statement: [...ownersAll.statement, ...read.statement],
    };
    expect(addsRetentionGrants(ownersAll, edited)).toBe(false);
  });

  it('catches a grant to a new principal, and treats a grant to everyone as covering all', () => {
    const widened: BucketPolicy = {
      statement: [
        ...ownersAll.statement,
        { effect: 'allow', principal: ['b'], action: ['s3:PutObjectRetention'] },
      ],
    };
    expect(addsRetentionGrants(ownersAll, widened)).toBe(true);

    const everyone: BucketPolicy = {
      statement: [{ effect: 'allow', principal: '*', action: [...RETENTION_WRITE_ACTIONS] }],
    };
    expect(addsRetentionGrants(everyone, widened)).toBe(false);
    expect(addsRetentionGrants(ownersAll, everyone)).toBe(true);
  });
});

describe('the roster statements', () => {
  it('names Owners with every action, Admins with the Admin set, and a Member creator apart', () => {
    const policy = defaultBucketPolicy({ owners: ['o1'], admins: ['a1'], creatorId: 'm1' });
    expect(policy.statement).toStrictEqual([
      { sid: ROSTER_OWNERS_SID, effect: 'allow', principal: ['o1'], action: ['s3:*'] },
      { sid: ROSTER_ADMINS_SID, effect: 'allow', principal: ['a1'], action: ROSTER_ADMIN_ACTIONS },
      { sid: ROSTER_CREATOR_SID, effect: 'allow', principal: ['m1'], action: ROSTER_ADMIN_ACTIONS },
    ]);
    expect(BucketPolicySchema.safeParse(policy).success).toBe(true);
  });

  it('gives an Owner or Admin creator no second statement, and drops a statement nobody would be in', () => {
    const owner = defaultBucketPolicy({ owners: ['o1'], admins: [], creatorId: 'o1' });
    expect(owner.statement.map((s) => s.sid)).toStrictEqual([ROSTER_OWNERS_SID]);
    const admin = defaultBucketPolicy({ owners: ['o1'], admins: ['a1'], creatorId: 'a1' });
    expect(admin.statement.map((s) => s.sid)).toStrictEqual([ROSTER_OWNERS_SID, ROSTER_ADMINS_SID]);
  });

  it('keeps the creator statement when the roster is rewritten', () => {
    const created = defaultBucketPolicy({ owners: ['o1'], admins: [], creatorId: 'm1' });
    const next = withRosterStatements(created, { owners: ['o2'], admins: ['o1'] });
    expect(next?.statement.map((s) => [s.sid, s.principal])).toStrictEqual([
      [ROSTER_OWNERS_SID, ['o2']],
      [ROSTER_ADMINS_SID, ['o1']],
      [ROSTER_CREATOR_SID, ['m1']],
    ]);
  });

  it('replaces only the roster statements and keeps every other statement', () => {
    const existing: BucketPolicy = {
      statement: [
        { sid: ROSTER_OWNERS_SID, effect: 'allow', principal: ['old-owner'], action: ['s3:*'] },
        { sid: 'team', effect: 'allow', principal: ['m1'], action: ['s3:GetObject'] },
      ],
    };
    const next = withRosterStatements(existing, { owners: ['new-owner'], admins: ['a1'] });
    expect(next?.statement.map((s) => s.sid)).toStrictEqual([
      ROSTER_OWNERS_SID,
      ROSTER_ADMINS_SID,
      'team',
    ]);
    expect(next?.statement[0].principal).toStrictEqual(['new-owner']);
  });

  it('answers null when nothing would be left, which means delete the policy', () => {
    expect(withRosterStatements(null, { owners: [], admins: [] })).toBeNull();
    expect(
      withRosterStatements(
        {
          statement: [
            { sid: ROSTER_OWNERS_SID, effect: 'allow', principal: ['o'], action: ['s3:*'] },
          ],
        },
        { owners: [], admins: [] },
      ),
    ).toBeNull();
  });
});
