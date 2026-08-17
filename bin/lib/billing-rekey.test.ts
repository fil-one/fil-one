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

/** An org row the application wrote: no provenance attributes. */
function applicationRow(): SubscriptionRow {
  const pk = BillingKeys.orgPk(ORG_ID);
  return {
    pk,
    attributes: attributes({
      pk,
      sk: 'SUBSCRIPTION',
      orgId: ORG_ID,
      userId: USER_ID,
      subscriptionId: 'sub_app',
      updatedAt: NEWER,
    }),
    orgId: ORG_ID,
    subscriptionId: 'sub_app',
    updatedAt: NEWER,
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

  it('skips an org whose copy still carries the source’s updatedAt', () => {
    const source = legacyRow();
    const plan = classifyOrgBilling(state({ legacyRows: [source], orgRow: copiedRow(source) }));

    expect(plan).toStrictEqual({ kind: 'already-copied', orgId: ORG_ID, origin: 'backfill' });
  });

  it('re-copies when the source moved after it was copied', () => {
    // The one way the pair diverges under dual-write: a Stripe object carrying
    // no metadata.orgId updates the legacy row alone.
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

    it('reports a foreign org row rather than re-pointing it', () => {
      // Two rows claim the org and one already won. Flipping which subscription
      // the org rides on the strength of scan order is not a decision a script
      // gets to make.
      const copied = copiedRow(legacyRow({ pk: BillingKeys.legacyPk(OTHER_USER_ID) }));

      expect(classifyOrgBilling(state({ legacyRows: [first], orgRow: copied }))).toMatchObject({
        kind: 'anomaly',
        reason: 'foreign-org-row',
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

  it('conditions a re-copy on the org row still belonging to this source', () => {
    const copied = copiedRow(legacyRow());
    const plan = classifyOrgBilling(
      state({ legacyRows: [legacyRow({ updatedAt: NEWER })], orgRow: copied }),
    ) as CopyPlan;
    const [put] = buildCopyTransactItems(plan, TABLE, NOW);

    expect(put.Put).toMatchObject({
      ConditionExpression: '#rekeyedFrom = :source',
      ExpressionAttributeNames: { '#rekeyedFrom': REKEY_ATTRIBUTES.from },
      ExpressionAttributeValues: { ':source': { S: BillingKeys.legacyPk(USER_ID) } },
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

  it('refuses an entry that names only one side', () => {
    // A resolution is "this org's live row is this one". Half of that is a typo,
    // and treating it as a decision would copy a row nobody chose.
    expect(() => parseResolvedCollisions(ORG_ID)).toThrow('are <orgId>=<userId>');
  });
});

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

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

  it('exempts an application-written row from the faithfulness check', () => {
    const { named } = checksFor([state({ legacyRows: [legacyRow()], orgRow: applicationRow() })]);

    expect(named('Every org twin says what its source says').pass).toBe(true);
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
