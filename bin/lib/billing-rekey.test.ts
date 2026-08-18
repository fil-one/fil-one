import { describe, expect, it } from 'vitest';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';

// The canonical source this file's mirror copies. A bin script cannot import it
// at runtime (Node's type stripping does not resolve the backend's `./x.js`
// specifiers), but vitest resolves it — so the mirror is held to it here rather
// than by hand.
import { SubscriptionKeys } from '@filone/backend/src/lib/subscription-store.js';

import {
  BillingKeys,
  buildCopyItem,
  buildCopyTransactItems,
  buildRevertItem,
  classifyOrgBilling,
  COMPARED_ATTRIBUTES,
  formatBillingPlanReport,
  parseLegacyPk,
  parseOrgPk,
  parseResolvedCollisions,
  unkeyableOrgAnomalies,
  validateResolvedCollisions,
  REKEY_ATTRIBUTES,
  summarizeBillingPlans,
} from './billing-rekey.ts';
import type {
  BillingPlan,
  BillingScanCounts,
  CopyPlan,
  OrgBillingState,
  SubscriptionRow,
} from './billing-rekey.ts';
import { formatBillingVerifyReport, verifyBillingRekey } from './billing-verify.ts';

const ORG_ID = '11111111-2222-3333-4444-555555555555';
const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_USER_ID = '99999999-8888-7777-6666-555555555555';
const UPDATED_AT = '2026-08-01T12:00:00.000Z';
const NEWER = '2026-08-09T12:00:00.000Z';
const NOW = '2026-08-15T09:00:00.000Z';
const TABLE = 'BillingTable';

/** A legacy row with the attributes the classification and the copy read. */
function legacyRow(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  const pk = overrides.pk ?? BillingKeys.legacyPk(USER_ID);
  const orgId = 'orgId' in overrides ? overrides.orgId : ORG_ID;
  const subscriptionId = 'subscriptionId' in overrides ? overrides.subscriptionId : 'sub_1';
  const updatedAt = 'updatedAt' in overrides ? overrides.updatedAt : UPDATED_AT;

  return {
    pk,
    attributes: attributes({
      pk,
      sk: 'SUBSCRIPTION',
      ...(orgId ? { orgId } : {}),
      ...(subscriptionId ? { subscriptionId } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      stripeCustomerId: 'cus_1',
      subscriptionStatus: 'active',
    }),
    ...(orgId ? { orgId } : {}),
    ...(subscriptionId ? { subscriptionId } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...overrides,
  };
}

/** An org row this backfill wrote, faithful to `source` unless told otherwise. */
function copiedRow(
  source: SubscriptionRow,
  overrides: Record<string, string> = {},
): SubscriptionRow {
  const pk = BillingKeys.orgPk(ORG_ID);
  const carried = Object.fromEntries(
    Object.entries(source.attributes)
      .filter(([key]) => key !== 'pk')
      .map(([key, value]) => [key, value.S ?? '']),
  );

  const stored: Record<string, string> = {
    ...carried,
    pk,
    orgId: ORG_ID,
    userId: parseLegacyPk(source.pk) ?? '',
    [REKEY_ATTRIBUTES.from]: source.pk,
    [REKEY_ATTRIBUTES.at]: NOW,
    ...(source.updatedAt ? { [REKEY_ATTRIBUTES.sourceUpdatedAt]: source.updatedAt } : {}),
    ...overrides,
  };

  return {
    pk,
    attributes: attributes(stored),
    orgId: stored.orgId,
    ...(stored.subscriptionId ? { subscriptionId: stored.subscriptionId } : {}),
    ...(stored.updatedAt ? { updatedAt: stored.updatedAt } : {}),
    rekeyedFrom: stored[REKEY_ATTRIBUTES.from],
    ...(stored[REKEY_ATTRIBUTES.sourceUpdatedAt]
      ? { rekeySourceUpdatedAt: stored[REKEY_ATTRIBUTES.sourceUpdatedAt] }
      : {}),
  };
}

/**
 * An org row the application wrote: no provenance attributes. It names the same
 * subscription as {@link legacyRow} unless a test is about the two disagreeing.
 */
function applicationRow(overrides: Record<string, string> = {}): SubscriptionRow {
  const pk = BillingKeys.orgPk(ORG_ID);
  const stored: Record<string, string> = {
    pk,
    sk: 'SUBSCRIPTION',
    orgId: ORG_ID,
    userId: USER_ID,
    subscriptionId: 'sub_1',
    updatedAt: NEWER,
    ...overrides,
  };

  return {
    pk,
    attributes: attributes(stored),
    orgId: stored.orgId,
    subscriptionId: stored.subscriptionId,
    updatedAt: stored.updatedAt,
  };
}

function attributes(values: Record<string, string>): Record<string, AttributeValue> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { S: value }]));
}

function state(overrides: Partial<OrgBillingState> = {}): OrgBillingState {
  return { orgId: ORG_ID, legacyRows: [], ...overrides };
}

const EMPTY_SCAN: BillingScanCounts = {
  subscriptionRows: 0,
  legacyRows: 0,
  orgRows: 0,
  copiedOrgRows: 0,
  unparsedRows: 0,
  orglessRows: 0,
};

// ---------------------------------------------------------------------------
// The mirror
// ---------------------------------------------------------------------------

describe('BillingKeys mirrors the backend', () => {
  it('builds the same keys the application reads and writes', () => {
    expect(BillingKeys.orgPk(ORG_ID)).toBe(SubscriptionKeys.orgPk(ORG_ID));
    expect(BillingKeys.orgPkPrefix()).toBe(SubscriptionKeys.orgPkPrefix());
    expect(BillingKeys.legacyPk(USER_ID)).toBe(SubscriptionKeys.legacyPk(USER_ID));
    expect(BillingKeys.legacyPkPrefix()).toBe(SubscriptionKeys.legacyPkPrefix());
    expect(BillingKeys.subscriptionSk()).toBe(SubscriptionKeys.sk());
  });

  it('parses a legacy key the same way', () => {
    expect(parseLegacyPk(BillingKeys.legacyPk(USER_ID))).toBe(
      SubscriptionKeys.parseLegacyPk(SubscriptionKeys.legacyPk(USER_ID)),
    );
    expect(parseLegacyPk(BillingKeys.orgPk(ORG_ID))).toBeUndefined();
    expect(parseOrgPk(BillingKeys.orgPk(ORG_ID))).toBe(ORG_ID);
    expect(parseOrgPk('ORG#a#b')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe('classifyOrgBilling', () => {
  it('copies a legacy row whose org has none', () => {
    const source = legacyRow();
    const plan = classifyOrgBilling(state({ legacyRows: [source] }));

    expect(plan).toMatchObject({
      kind: 'copy',
      orgId: ORG_ID,
      userId: USER_ID,
      reason: 'first-copy',
      sourceUpdatedAt: UPDATED_AT,
    });
  });

  it('skips an org whose two rows agree', () => {
    const source = legacyRow();
    const plan = classifyOrgBilling(state({ legacyRows: [source], orgRow: copiedRow(source) }));

    expect(plan).toStrictEqual({ kind: 'already-copied', orgId: ORG_ID, origin: 'backfill' });
  });

  it('skips an org whose copy is AHEAD of its legacy row', () => {
    // The dual-write's own doing: a write that reached the org row alone leaves
    // the legacy row behind. Every reader prefers the org row and the flip
    // deletes the legacy one, so nothing is served stale and there is nothing to
    // copy. The frozen rekeySourceUpdatedAt would have called this a delta on
    // every run forever, which is why --verify could not converge.
    const copied = copiedRow(legacyRow(), { updatedAt: NEWER });

    expect(classifyOrgBilling(state({ legacyRows: [legacyRow()], orgRow: copied }))).toStrictEqual({
      kind: 'already-copied',
      orgId: ORG_ID,
      origin: 'backfill',
    });
  });

  it('does not re-flag a copy just because its source was written again', () => {
    // Every ordinary dual-write moves the source's updatedAt while the copy's
    // rekeySourceUpdatedAt stays frozen. Both rows moved together here, so the
    // pair is in sync and the run has nothing to do.
    const copied = copiedRow(legacyRow(), { updatedAt: NEWER });
    const rewritten = legacyRow({ updatedAt: NEWER });

    expect(classifyOrgBilling(state({ legacyRows: [rewritten], orgRow: copied }))).toStrictEqual({
      kind: 'already-copied',
      orgId: ORG_ID,
      origin: 'backfill',
    });
  });

  it('re-copies when the legacy row is newer than the org row', () => {
    const copied = copiedRow(legacyRow());
    const moved = legacyRow({ updatedAt: NEWER });

    expect(classifyOrgBilling(state({ legacyRows: [moved], orgRow: copied }))).toMatchObject({
      kind: 'copy',
      reason: 'delta',
      copiedUpdatedAt: UPDATED_AT,
      sourceUpdatedAt: NEWER,
    });
  });

  it('never copies over a row the application wrote', () => {
    // It has no legacy source to be faithful to: the dual-write put it there
    // beside its twin, and it is the live state.
    const plan = classifyOrgBilling(
      state({ legacyRows: [legacyRow({ updatedAt: UPDATED_AT })], orgRow: applicationRow() }),
    );

    expect(plan).toStrictEqual({ kind: 'already-copied', orgId: ORG_ID, origin: 'application' });
  });

  it('reports an application row its legacy row has moved past', () => {
    // The blanket exemption hid this: the flip deletes the legacy row, so state
    // only the legacy row holds is state about to be lost. The app row is still
    // never overwritten — a human reconciles it.
    const behind = applicationRow({ updatedAt: UPDATED_AT });

    expect(
      classifyOrgBilling(state({ legacyRows: [legacyRow({ updatedAt: NEWER })], orgRow: behind })),
    ).toMatchObject({ kind: 'anomaly', reason: 'app-row-behind' });
  });

  it('reports an application row naming a different subscription than its legacy row', () => {
    // Nothing downstream can catch this one: verification exempts a row with no
    // rekeyedFrom from the faithfulness check, and the org row is newer, so the
    // timestamp comparison passes it as settled. Two subscriptions for one org
    // is the fact, whichever row is fresher.
    const plan = classifyOrgBilling(
      state({ legacyRows: [legacyRow()], orgRow: applicationRow({ subscriptionId: 'sub_app' }) }),
    );

    expect(plan).toMatchObject({ kind: 'anomaly', reason: 'app-row-mismatch' });
    expect((plan as { detail: string }).detail).toContain('sub_app');
    expect((plan as { detail: string }).detail).toContain('sub_1');
  });

  it('reports an application row that names no subscription at all', () => {
    // Absent agrees with nothing: the legacy row holds the only subscription id
    // either row has, and the flip is about to delete it.
    expect(
      classifyOrgBilling(
        state({ legacyRows: [legacyRow()], orgRow: applicationRow({ subscriptionId: '' }) }),
      ),
    ).toMatchObject({ kind: 'anomaly', reason: 'app-row-mismatch' });
  });

  it('surfaces a collision even when an application row exists', () => {
    // Two subscriptions claiming one org is a fact about the account, not about
    // which key its row happens to be on.
    const rival = legacyRow({ pk: BillingKeys.legacyPk(OTHER_USER_ID), subscriptionId: 'sub_2' });

    expect(
      classifyOrgBilling(state({ legacyRows: [legacyRow(), rival], orgRow: applicationRow() })),
    ).toMatchObject({ kind: 'anomaly', reason: 'collision' });
  });

  it('leaves an org row whose source is gone for the revert', () => {
    expect(classifyOrgBilling(state({ orgRow: copiedRow(legacyRow()) }))).toStrictEqual({
      kind: 'already-copied',
      orgId: ORG_ID,
      origin: 'backfill',
    });
  });

  describe('when several legacy rows name one org', () => {
    const first = legacyRow({ updatedAt: UPDATED_AT });
    const second = legacyRow({
      pk: BillingKeys.legacyPk(OTHER_USER_ID),
      updatedAt: NEWER,
    });

    it('copies the newest when they agree on the subscription', () => {
      // Re-subscription residue describing the same Stripe subscription: either
      // row copies to the same billing state, so the freshest wins and the other
      // is recorded rather than silently ignored.
      const plan = classifyOrgBilling(state({ legacyRows: [first, second] }));

      expect(plan).toMatchObject({
        kind: 'copy',
        userId: OTHER_USER_ID,
        supersedes: [first.pk],
      });
    });

    it('halts as a collision when they name different subscriptions', () => {
      const rival = legacyRow({
        pk: BillingKeys.legacyPk(OTHER_USER_ID),
        subscriptionId: 'sub_2',
      });

      expect(classifyOrgBilling(state({ legacyRows: [first, rival] }))).toMatchObject({
        kind: 'anomaly',
        reason: 'collision',
        rows: [first.pk, rival.pk],
      });
    });

    it('copies the row an operator named, whatever its updatedAt', () => {
      const rival = legacyRow({
        pk: BillingKeys.legacyPk(OTHER_USER_ID),
        subscriptionId: 'sub_2',
        updatedAt: NEWER,
      });
      const resolved = new Map([[ORG_ID, USER_ID]]);

      expect(classifyOrgBilling(state({ legacyRows: [first, rival] }), resolved)).toMatchObject({
        kind: 'copy',
        userId: USER_ID,
        supersedes: [rival.pk],
      });
    });

    it('reads the recorded winner back rather than re-deriving it', () => {
      // rekeyedFrom IS the resolution: an operator checked Stripe and named this
      // row. Re-deriving would halt on the same collision every run, and would
      // need --resolve-collisions passed forever.
      const rival = legacyRow({
        pk: BillingKeys.legacyPk(OTHER_USER_ID),
        subscriptionId: 'sub_2',
        updatedAt: NEWER,
      });
      const copied = copiedRow(first);

      expect(
        classifyOrgBilling(state({ legacyRows: [first, rival], orgRow: copied })),
      ).toStrictEqual({ kind: 'already-copied', orgId: ORG_ID, origin: 'backfill' });
    });

    it('names the anomaly when the recorded winner is gone and another claimant survives', () => {
      // Not a dead end: the halt text carries what to check in Stripe and what
      // to do either way.
      const copied = copiedRow(legacyRow({ pk: BillingKeys.legacyPk(OTHER_USER_ID) }));

      const plan = classifyOrgBilling(state({ legacyRows: [first], orgRow: copied }));
      expect(plan).toMatchObject({ kind: 'anomaly', reason: 'foreign-org-row' });
      expect((plan as { detail: string }).detail).toContain('no longer in the table');
      expect((plan as { detail: string }).detail).toContain('delete the org row and re-run');
    });

    it('halts when a claimant names no subscription at all', () => {
      // Two rows that agree on nothing are the same problem as two that
      // disagree; collapsing their missing ids into one Set entry read as
      // agreement.
      const nameless = legacyRow({
        pk: BillingKeys.legacyPk(OTHER_USER_ID),
        subscriptionId: '',
      });

      expect(classifyOrgBilling(state({ legacyRows: [first, nameless] }))).toMatchObject({
        kind: 'anomaly',
        reason: 'collision',
      });
    });
  });
});

// ---------------------------------------------------------------------------
// The items
// ---------------------------------------------------------------------------

describe('buildCopyItem', () => {
  const plan = classifyOrgBilling(state({ legacyRows: [legacyRow()] })) as CopyPlan;

  it('carries every source attribute, re-keyed to the org', () => {
    const { item, pk } = buildCopyItem(plan, NOW);

    expect(pk).toBe(BillingKeys.orgPk(ORG_ID));
    expect(item).toStrictEqual({
      pk: { S: BillingKeys.orgPk(ORG_ID) },
      sk: { S: 'SUBSCRIPTION' },
      orgId: { S: ORG_ID },
      userId: { S: USER_ID },
      subscriptionId: { S: 'sub_1' },
      stripeCustomerId: { S: 'cus_1' },
      subscriptionStatus: { S: 'active' },
      updatedAt: { S: UPDATED_AT },
      [REKEY_ATTRIBUTES.from]: { S: BillingKeys.legacyPk(USER_ID) },
      [REKEY_ATTRIBUTES.at]: { S: NOW },
      [REKEY_ATTRIBUTES.sourceUpdatedAt]: { S: UPDATED_AT },
    });
  });

  it('writes the userId the key carried, so nothing has to parse a pk after the flip', () => {
    expect(buildCopyItem(plan, NOW).item.userId).toStrictEqual({ S: USER_ID });
  });

  it('writes orgId from the classification, so key and attribute cannot disagree', () => {
    const lying = legacyRow();
    lying.attributes.orgId = { S: 'a-different-org' };
    const fromLyingRow = classifyOrgBilling(state({ legacyRows: [lying] })) as CopyPlan;

    expect(buildCopyItem(fromLyingRow, NOW).item.orgId).toStrictEqual({ S: ORG_ID });
  });
});

describe('buildCopyTransactItems', () => {
  it('asserts the source has not moved since it was read', () => {
    const plan = classifyOrgBilling(state({ legacyRows: [legacyRow()] })) as CopyPlan;
    const [put, check] = buildCopyTransactItems(plan, TABLE, NOW);

    expect(put.Put).toMatchObject({
      TableName: TABLE,
      ConditionExpression: 'attribute_not_exists(pk)',
    });
    expect(check.ConditionCheck).toStrictEqual({
      TableName: TABLE,
      Key: { pk: { S: BillingKeys.legacyPk(USER_ID) }, sk: { S: 'SUBSCRIPTION' } },
      ConditionExpression: '#updatedAt = :sourceUpdatedAt',
      ExpressionAttributeNames: { '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: { ':sourceUpdatedAt': { S: UPDATED_AT } },
    });
  });

  it('asserts a source with no updatedAt still has none', () => {
    // Absence is a state a later write can leave, so the copy has to condition
    // on it rather than skip the check and copy a row that has since moved.
    const plan = classifyOrgBilling(
      state({ legacyRows: [legacyRow({ updatedAt: undefined })] }),
    ) as CopyPlan;
    const [, check] = buildCopyTransactItems(plan, TABLE, NOW);

    expect(check.ConditionCheck?.ConditionExpression).toBe(
      'attribute_exists(pk) AND attribute_not_exists(#updatedAt)',
    );
  });

  it('conditions a re-copy on the org row still belonging to this source, unmoved', () => {
    // A Put replaces the whole item, so a webhook write that lands on the org
    // row inside the window is not merged by this copy, it is erased by it. The
    // second half of the condition turns that into a race the run reports.
    const copied = copiedRow(legacyRow());
    const plan = classifyOrgBilling(
      state({ legacyRows: [legacyRow({ updatedAt: NEWER })], orgRow: copied }),
    ) as CopyPlan;
    const [put] = buildCopyTransactItems(plan, TABLE, NOW);

    expect(put.Put).toMatchObject({
      ConditionExpression: '#rekeyedFrom = :source AND #updatedAt = :orgUpdatedAt',
      ExpressionAttributeNames: {
        '#rekeyedFrom': REKEY_ATTRIBUTES.from,
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':source': { S: BillingKeys.legacyPk(USER_ID) },
        ':orgUpdatedAt': { S: UPDATED_AT },
      },
    });
  });
});

describe('buildRevertItem', () => {
  it('deletes only a row still copied from the source the revert read', () => {
    const [item] = buildRevertItem(ORG_ID, BillingKeys.legacyPk(USER_ID), TABLE);

    expect(item.Delete).toStrictEqual({
      TableName: TABLE,
      Key: { pk: { S: BillingKeys.orgPk(ORG_ID) }, sk: { S: 'SUBSCRIPTION' } },
      ConditionExpression: 'attribute_exists(pk) AND #rekeyedFrom = :source',
      ExpressionAttributeNames: { '#rekeyedFrom': REKEY_ATTRIBUTES.from },
      ExpressionAttributeValues: { ':source': { S: BillingKeys.legacyPk(USER_ID) } },
    });
  });

  it('requires the legacy row to still be the one the store would fall back to', () => {
    // The fallback this delete promises is narrower than "the row exists":
    // readSubscription refuses a legacy row whose orgId names another org, and
    // serves one carrying no orgId. A revert conditioned on existence alone
    // deletes the org row, prints DELETED, and leaves the account reading as
    // having no subscription at all.
    const [, check] = buildRevertItem(ORG_ID, BillingKeys.legacyPk(USER_ID), TABLE);

    expect(check.ConditionCheck).toStrictEqual({
      TableName: TABLE,
      Key: { pk: { S: BillingKeys.legacyPk(USER_ID) }, sk: { S: 'SUBSCRIPTION' } },
      ConditionExpression:
        'attribute_exists(pk) AND (attribute_not_exists(#orgId) OR #orgId = :orgId)',
      ExpressionAttributeNames: { '#orgId': 'orgId' },
      ExpressionAttributeValues: { ':orgId': { S: ORG_ID } },
    });
  });
});

// ---------------------------------------------------------------------------
// Rows this migration cannot key
// ---------------------------------------------------------------------------

describe('unkeyableOrgAnomalies', () => {
  it('names the rows whose orgId cannot form a key, one anomaly per org', () => {
    // Before the plan, not after the write: an --execute run that copies these
    // to ORG#a#b only finds out on the next run's --verify, by which time the
    // row it fails on is one it wrote.
    const anomalies = unkeyableOrgAnomalies([
      legacyRow({ orgId: 'a#b' }),
      legacyRow({ pk: BillingKeys.legacyPk(OTHER_USER_ID), orgId: 'a#b' }),
    ]);

    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      kind: 'anomaly',
      orgId: 'a#b',
      reason: 'no-org-id',
      rows: [BillingKeys.legacyPk(USER_ID), BillingKeys.legacyPk(OTHER_USER_ID)],
    });
    expect(anomalies[0].detail).toContain('cannot be half of a key');
  });

  it('leaves the rows this migration can key alone', () => {
    expect(unkeyableOrgAnomalies([legacyRow(), legacyRow({ orgId: undefined })])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Collision resolution as an operator types it
// ---------------------------------------------------------------------------

describe('parseResolvedCollisions', () => {
  it('accepts the prefixed forms the report prints', () => {
    const resolved = parseResolvedCollisions(
      `${BillingKeys.orgPk(ORG_ID)}=${BillingKeys.legacyPk(USER_ID)}`,
    );

    expect(resolved.get(ORG_ID)).toBe(USER_ID);
  });

  it('accepts bare ids and ignores surrounding space', () => {
    expect(parseResolvedCollisions(` ${ORG_ID} = ${USER_ID} , `).get(ORG_ID)).toBe(USER_ID);
  });

  it('reads nothing from nothing', () => {
    expect(parseResolvedCollisions(undefined).size).toBe(0);
  });

  it('refuses two entries for one org', () => {
    // An operator who edited a list and left the old line in; taking the last
    // would copy the subscription they had already decided against.
    expect(() =>
      parseResolvedCollisions(
        `ORG#${ORG_ID}=CUSTOMER#${USER_ID},ORG#${ORG_ID}=CUSTOMER#${OTHER_USER_ID}`,
      ),
    ).toThrow('twice');
  });

  it('refuses an entry that names only one side', () => {
    // A resolution is "this org's live row is this one". Half of that is a typo,
    // and treating it as a decision would copy a row nobody chose.
    expect(() => parseResolvedCollisions(ORG_ID)).toThrow('are <orgId>=<userId>');
  });
});

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

describe('validateResolvedCollisions', () => {
  it('accepts a resolution naming a row that claims the org', () => {
    const rows = [legacyRow(), legacyRow({ pk: BillingKeys.legacyPk(OTHER_USER_ID) })];
    const states = [state({ legacyRows: rows })];

    expect(validateResolvedCollisions(new Map([[ORG_ID, USER_ID]]), states)).toEqual([]);
  });

  it('names a resolution for an org nothing scanned', () => {
    // Its failure mode is the confusing one: the run halts on the same collision
    // and the halt reads as the argument not having been passed.
    const problems = validateResolvedCollisions(new Map([['other-org', USER_ID]]), [
      state({ legacyRows: [legacyRow()] }),
    ]);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no scanned row names that org');
  });

  it('names a resolution whose row does not claim the org', () => {
    const problems = validateResolvedCollisions(new Map([[ORG_ID, OTHER_USER_ID]]), [
      state({ legacyRows: [legacyRow()] }),
    ]);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('does not claim this org');
    expect(problems[0]).toContain(BillingKeys.legacyPk(USER_ID));
  });
});

describe('verifyBillingRekey', () => {
  function checksFor(
    states: OrgBillingState[],
    orglessRows: string[] = [],
    accepted: Set<string> = new Set(),
  ) {
    const plans: BillingPlan[] = states.map((s) => classifyOrgBilling(s));
    const scan: BillingScanCounts = {
      ...EMPTY_SCAN,
      legacyRows: states.reduce((n, s) => n + s.legacyRows.length, 0) + orglessRows.length,
      orgRows: states.filter((s) => s.orgRow).length,
      copiedOrgRows: states.filter((s) => s.orgRow?.rekeyedFrom).length,
      orglessRows: orglessRows.length,
    };
    const checks = verifyBillingRekey({
      states,
      plans,
      scan,
      orglessRows,
      acceptedOrgless: accepted,
    });
    return { checks, named: (name: string) => checks.find((c) => c.name.startsWith(name))! };
  }

  it('passes a table whose every legacy row has a faithful twin', () => {
    const source = legacyRow();
    const { checks } = checksFor([state({ legacyRows: [source], orgRow: copiedRow(source) })]);

    expect(checks.every((check) => check.pass)).toBe(true);
    expect(formatBillingVerifyReport(checks)).toContain('VERIFY: PASS');
  });

  it('fails an org whose legacy row has no twin', () => {
    const { named } = checksFor([state({ legacyRows: [legacyRow()] })]);

    expect(named('Every legacy row that names an org has an org twin')).toMatchObject({
      pass: false,
    });
    expect(named('No org still has a row to copy').pass).toBe(false);
  });

  it('names the attribute on which a twin disagrees with its source', () => {
    // A stale subscriptionStatus is the difference between a served customer and
    // a locked one, so the check says which attribute and both values.
    const source = legacyRow();
    const stale = copiedRow(source, { subscriptionStatus: 'canceled' });
    const { named } = checksFor([state({ legacyRows: [source], orgRow: stale })]);

    const check = named('Every org twin says what its source says');
    expect(check.pass).toBe(false);
    expect(check.offenders[0]).toContain('subscriptionStatus: source=active copy=canceled');
  });

  it('fails a twin whose source no longer exists', () => {
    const { named } = checksFor([state({ orgRow: copiedRow(legacyRow()) })]);

    const check = named('Every org twin says what its source says');
    expect(check.pass).toBe(false);
    expect(check.offenders[0]).toContain('no longer exists');
  });

  it('fails an org row carrying somebody else’s orgId', () => {
    const source = legacyRow();
    const wrong = copiedRow(source, { orgId: 'a-different-org' });
    wrong.orgId = 'a-different-org';
    const { named } = checksFor([state({ legacyRows: [source], orgRow: wrong })]);

    expect(named('Every org row’s orgId attribute matches its key').pass).toBe(false);
  });

  it('reports an application row whose legacy row holds newer state', () => {
    // The exemption used to cover this: the flip deletes the legacy row, so
    // state only it holds is state about to be lost.
    const { named } = checksFor([
      state({
        legacyRows: [legacyRow({ updatedAt: NEWER })],
        orgRow: applicationRow({ updatedAt: UPDATED_AT }),
      }),
    ]);

    expect(named('No org is claimed by two subscriptions').pass).toBe(false);
  });

  it('reports an application row and a legacy row naming different subscriptions', () => {
    // The faithfulness check cannot see it — an application row has no source to
    // be faithful to — so the anomaly check is the only place it surfaces.
    const { named } = checksFor([
      state({ legacyRows: [legacyRow()], orgRow: applicationRow({ subscriptionId: 'sub_app' }) }),
    ]);

    expect(named('Every org twin says what its source says').pass).toBe(true);
    expect(named('No org is claimed by two subscriptions').pass).toBe(false);
  });

  it('exempts an application-written row from the faithfulness check', () => {
    const { named } = checksFor([state({ legacyRows: [legacyRow()], orgRow: applicationRow() })]);

    expect(named('Every org twin says what its source says').pass).toBe(true);
  });

  it('fails, and names, a key this migration cannot parse', () => {
    // A counted row is a row nobody looks at, and the flip deletes the legacy
    // rows regardless of whether this script could read their keys.
    const plans: BillingPlan[] = [];
    const checks = verifyBillingRekey({
      states: [],
      plans,
      scan: { ...EMPTY_SCAN, subscriptionRows: 2, unparsedRows: 1 },
      orglessRows: [],
      unparsedRows: ['SUBSCRIPTION#weird'],
    });
    const check = checks.find((c) => c.name.startsWith('Every SUBSCRIPTION row has a key'))!;

    expect(check.pass).toBe(false);
    expect(check.offenders[0]).toContain('SUBSCRIPTION#weird');
  });

  it('fails an orgId attribute that cannot form a key', () => {
    // `ORG#a#b` parses back as something else, so the row would be filed under
    // an org that does not exist.
    const checks = verifyBillingRekey({
      states: [],
      plans: [],
      scan: EMPTY_SCAN,
      orglessRows: [],
      unkeyableOrgIds: [`${BillingKeys.legacyPk(USER_ID)} carries orgId="a#b"`],
    });
    const check = checks.find((c) => c.name.startsWith('Every SUBSCRIPTION row has a key'))!;

    expect(check.pass).toBe(false);
  });

  it('fails an org row carrying no orgId attribute at all', () => {
    // Every lifecycle job reads the attribute, not the key, so a row without one
    // is invisible to all of them.
    const source = legacyRow();
    const copied = copiedRow(source);
    delete copied.orgId;
    const { named } = checksFor([state({ legacyRows: [source], orgRow: copied })]);

    expect(named('Every org row’s orgId attribute matches its key').pass).toBe(false);
  });

  it('fails a legacy row with no orgId until it is named', () => {
    const orgless = [BillingKeys.legacyPk('orphan-1')];
    const before = checksFor([], orgless);
    expect(before.named('Every legacy row with no orgId').pass).toBe(false);

    const after = checksFor([], orgless, new Set(orgless));
    const check = after.named('Every legacy row with no orgId');
    expect(check.pass).toBe(true);
    expect(check.accepted).toEqual(orgless);
  });

  it('echoes an acceptance that no longer matches a row', () => {
    const { named } = checksFor([], [], new Set([BillingKeys.legacyPk('gone')]));

    expect(named('Every legacy row with no orgId').accepted?.[0]).toContain(
      'no longer a row without an orgId',
    );
  });

  it('fails an unresolved collision', () => {
    const rival = legacyRow({
      pk: BillingKeys.legacyPk(OTHER_USER_ID),
      subscriptionId: 'sub_2',
    });
    const { named } = checksFor([state({ legacyRows: [legacyRow(), rival] })]);

    expect(named('No org is claimed by two subscriptions').pass).toBe(false);
  });

  it('reports FAIL with a count when any check fails', () => {
    const { checks } = checksFor([state({ legacyRows: [legacyRow()] })]);

    expect(formatBillingVerifyReport(checks)).toContain('VERIFY: FAIL (2 checks)');
  });

  it('compares the billing state and not the provenance attributes', () => {
    // The copy carries rekeyedFrom/rekeyedAt by design; comparing them would
    // fail every row the backfill wrote.
    for (const attribute of REKEY_ATTRIBUTES_VALUES) {
      expect(COMPARED_ATTRIBUTES).not.toContain(attribute);
    }
  });
});

const REKEY_ATTRIBUTES_VALUES = Object.values(REKEY_ATTRIBUTES);

// ---------------------------------------------------------------------------
// The plan report
// ---------------------------------------------------------------------------

describe('formatBillingPlanReport', () => {
  it('counts what each classification decided', () => {
    const source = legacyRow();
    const plans: BillingPlan[] = [
      classifyOrgBilling(state({ legacyRows: [source] })),
      classifyOrgBilling(state({ legacyRows: [source], orgRow: copiedRow(source) })),
      classifyOrgBilling(state({ legacyRows: [source], orgRow: applicationRow() })),
    ];

    expect(summarizeBillingPlans(plans)).toStrictEqual({
      orgs: 3,
      firstCopies: 1,
      deltas: 0,
      alreadyCopiedByBackfill: 1,
      alreadyCopiedByApplication: 1,
      supersededRows: 0,
      anomalies: 0,
    });
  });

  it('says plainly that it deletes nothing', () => {
    const report = formatBillingPlanReport(EMPTY_SCAN, [], []);

    expect(report).toContain('deletes nothing');
    expect(report).toContain('Every CUSTOMER# row stays until the dated cleanup step');
  });

  it('enumerates the rows with no orgId for manual disposition', () => {
    const orgless = [BillingKeys.legacyPk('orphan-1'), BillingKeys.legacyPk('orphan-2')];
    const report = formatBillingPlanReport({ ...EMPTY_SCAN, orglessRows: 2 }, [], orgless);

    expect(report).toContain('Legacy rows with no orgId (2)');
    for (const pk of orgless) expect(report).toContain(pk);
  });

  it('lists an anomaly with the reason it is one', () => {
    const rival = legacyRow({
      pk: BillingKeys.legacyPk(OTHER_USER_ID),
      subscriptionId: 'sub_2',
    });
    const plans = [classifyOrgBilling(state({ legacyRows: [legacyRow(), rival] }))];

    const report = formatBillingPlanReport(EMPTY_SCAN, plans, []);
    expect(report).toContain('[collision]');
    expect(report).toContain('sub_2');
  });
});
