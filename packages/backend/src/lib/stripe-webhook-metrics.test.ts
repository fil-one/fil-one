import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reportMetric } from './metrics.js';

vi.mock('./metrics.js', () => ({
  reportMetric: vi.fn(),
}));

const reportMetricMock = vi.mocked(reportMetric);

import {
  bucketAttempt,
  emitDunningEscalation,
  emitInvoiceFinalizationFailed,
  emitInvoiceFinalized,
  emitInvoicePaid,
} from './stripe-webhook-metrics.js';

describe('stripe-webhook-metrics', () => {
  beforeEach(() => {
    reportMetricMock.mockReset();
  });

  describe('bucketAttempt', () => {
    it('returns "unknown" for null/undefined/0', () => {
      expect(bucketAttempt(null)).toBe('unknown');
      expect(bucketAttempt(undefined)).toBe('unknown');
      expect(bucketAttempt(0)).toBe('unknown');
    });

    it('returns the count as a string for 1-3', () => {
      expect(bucketAttempt(1)).toBe('1');
      expect(bucketAttempt(2)).toBe('2');
      expect(bucketAttempt(3)).toBe('3');
    });

    it('buckets 4+ into "4+"', () => {
      expect(bucketAttempt(4)).toBe('4+');
      expect(bucketAttempt(5)).toBe('4+');
      expect(bucketAttempt(99)).toBe('4+');
    });
  });

  describe('emitInvoicePaid', () => {
    it('reports a dimensionless InvoicePaid=1 EMF event', () => {
      emitInvoicePaid();

      expect(reportMetricMock).toHaveBeenCalledTimes(1);
      const event = reportMetricMock.mock.calls[0][0];
      expect(event).toMatchObject({ InvoicePaid: 1 });
      expect(event._aws).toMatchObject({
        CloudWatchMetrics: [
          {
            Namespace: 'FilOne',
            Dimensions: [[]],
            Metrics: [{ Name: 'InvoicePaid', Unit: 'Count' }],
          },
        ],
      });
    });
  });

  describe('emitInvoiceFinalized', () => {
    it('reports a dimensionless InvoiceFinalized=1 EMF event', () => {
      emitInvoiceFinalized();

      expect(reportMetricMock).toHaveBeenCalledTimes(1);
      const event = reportMetricMock.mock.calls[0][0];
      expect(event).toMatchObject({ InvoiceFinalized: 1 });
      expect(event._aws).toMatchObject({
        CloudWatchMetrics: [
          {
            Namespace: 'FilOne',
            Dimensions: [[]],
            Metrics: [{ Name: 'InvoiceFinalized', Unit: 'Count' }],
          },
        ],
      });
    });
  });

  describe('emitInvoiceFinalizationFailed', () => {
    it('reports InvoiceFinalizationFailed=1 with the reason dimension', () => {
      emitInvoiceFinalizationFailed('tax_calculation_failed');

      expect(reportMetricMock).toHaveBeenCalledTimes(1);
      const event = reportMetricMock.mock.calls[0][0];
      expect(event).toMatchObject({
        reason: 'tax_calculation_failed',
        InvoiceFinalizationFailed: 1,
      });
      expect(event._aws).toMatchObject({
        CloudWatchMetrics: [
          {
            Namespace: 'FilOne',
            Dimensions: [['reason']],
            Metrics: [{ Name: 'InvoiceFinalizationFailed', Unit: 'Count' }],
          },
        ],
      });
    });

    it('passes through "unknown" reason verbatim', () => {
      emitInvoiceFinalizationFailed('unknown');

      expect(reportMetricMock.mock.calls[0][0]).toMatchObject({ reason: 'unknown' });
    });
  });

  describe('emitDunningEscalation', () => {
    it('reports DunningEscalation=1 with stage/reason/attemptBucket dimensions', () => {
      emitDunningEscalation({
        stage: 'entered',
        reason: 'card_declined',
        attemptBucket: '1',
      });

      expect(reportMetricMock).toHaveBeenCalledTimes(1);
      const event = reportMetricMock.mock.calls[0][0];
      expect(event).toMatchObject({
        stage: 'entered',
        reason: 'card_declined',
        attemptBucket: '1',
        DunningEscalation: 1,
      });
      expect(event._aws).toMatchObject({
        CloudWatchMetrics: [
          {
            Namespace: 'FilOne',
            Dimensions: [['stage', 'reason', 'attemptBucket']],
            Metrics: [{ Name: 'DunningEscalation', Unit: 'Count' }],
          },
        ],
      });
    });

    it('forwards each stage variant correctly', () => {
      const stages = ['entered', 'retry', 'recovered', 'canceled'] as const;
      for (const stage of stages) {
        emitDunningEscalation({ stage, reason: 'payment_failed', attemptBucket: '4+' });
      }

      expect(reportMetricMock).toHaveBeenCalledTimes(stages.length);
      stages.forEach((stage, i) => {
        expect(reportMetricMock.mock.calls[i][0]).toMatchObject({ stage });
      });
    });
  });
});
