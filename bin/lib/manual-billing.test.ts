import { describe, expect, it } from 'vitest';
import { SubscriptionStatus } from '@filone/shared';

import { planManualBilling } from './manual-billing.ts';

const NOW = new Date('2026-11-04T12:00:00.000Z');

describe('planManualBilling, setting manual billing', () => {
  it('sets manual and clears the lapse markers, conditioned on the status it read', () => {
    expect(
      planManualBilling({
        mode: 'set',
        row: { subscriptionStatus: SubscriptionStatus.Trialing },
        now: NOW,
      }),
    ).toStrictEqual({
      ok: true,
      value: {
        update: {
          UpdateExpression:
            'SET subscriptionStatus = :to, updatedAt = :now ' +
            'REMOVE gracePeriodEndsAt, canceledAt, lastPaymentFailedAt',
          ConditionExpression: 'attribute_exists(pk) AND subscriptionStatus = :from',
          ExpressionAttributeValues: {
            ':to': { S: SubscriptionStatus.Manual },
            ':from': { S: SubscriptionStatus.Trialing },
            ':now': { S: NOW.toISOString() },
          },
        },
        warnings: [],
      },
    });
  });

  it('conditions on the row existing without a status, for a row that has none', () => {
    // A customer mapping left by an abandoned card form. Without the row
    // condition, a row deleted since the read would be recreated.
    const plan = planManualBilling({ mode: 'set', row: {}, now: NOW });

    expect(plan).toMatchObject({
      ok: true,
      value: {
        update: {
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(subscriptionStatus)',
        },
      },
    });
    expect(plan.ok && plan.value.update.ExpressionAttributeValues).not.toHaveProperty(':from');
  });

  it('refuses an org with no billing row', () => {
    expect(planManualBilling({ mode: 'set', row: undefined, now: NOW })).toStrictEqual({
      ok: false,
      refusal: 'The org has no billing row.',
    });
  });

  it('refuses an org that is already billed manually', () => {
    expect(
      planManualBilling({
        mode: 'set',
        row: { subscriptionStatus: SubscriptionStatus.Manual },
        now: NOW,
      }),
    ).toStrictEqual({ ok: false, refusal: 'The org is already billed manually.' });
  });

  it.each([SubscriptionStatus.GracePeriod, SubscriptionStatus.Canceled])(
    'warns that the tenants may still be locked when the row was %s',
    (subscriptionStatus) => {
      expect(
        planManualBilling({ mode: 'set', row: { subscriptionStatus }, now: NOW }),
      ).toMatchObject({
        ok: true,
        value: {
          warnings: [
            `The org was ${subscriptionStatus}, so its tenants may be write-locked or disabled. ` +
              'This script does not unlock them.',
          ],
        },
      });
    },
  );
});

describe('planManualBilling, reverting manual billing', () => {
  it('starts the paid grace period a lapsed subscription gets, dated from now', () => {
    expect(
      planManualBilling({
        mode: 'revert',
        row: { subscriptionStatus: SubscriptionStatus.Manual },
        now: NOW,
      }),
    ).toStrictEqual({
      ok: true,
      value: {
        update: {
          UpdateExpression:
            'SET subscriptionStatus = :to, canceledAt = :now, gracePeriodEndsAt = :grace, updatedAt = :now',
          ConditionExpression: 'attribute_exists(pk) AND subscriptionStatus = :from',
          ExpressionAttributeValues: {
            ':to': { S: SubscriptionStatus.GracePeriod },
            ':from': { S: SubscriptionStatus.Manual },
            ':now': { S: NOW.toISOString() },
            ':grace': { S: '2026-12-04T12:00:00.000Z' },
          },
        },
        warnings: [],
      },
    });
  });

  it('refuses an org that is not billed manually', () => {
    expect(
      planManualBilling({
        mode: 'revert',
        row: { subscriptionStatus: SubscriptionStatus.Active },
        now: NOW,
      }),
    ).toStrictEqual({ ok: false, refusal: 'The org is not billed manually (it is active).' });
  });
});
