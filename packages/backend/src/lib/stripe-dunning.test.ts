import { describe, expect, it, vi } from 'vitest';
import { reportMetric } from './metrics.js';
import { bucketAttempt, emitDunningEscalation } from './stripe-dunning.js';

vi.mock('./metrics.js', () => ({
  reportMetric: vi.fn(),
}));

const reportMetricMock = vi.mocked(reportMetric);

describe('bucketAttempt', () => {
  it.each([
    [undefined, 'unknown'],
    [null, 'unknown'],
    [0, 'unknown'],
    [-1, 'unknown'],
  ])('returns "unknown" for %s', (input, expected) => {
    expect(bucketAttempt(input)).toBe(expected);
  });

  it.each([
    [1, '1'],
    [2, '2'],
    [3, '3'],
  ])('returns string form for attempt count %s', (input, expected) => {
    expect(bucketAttempt(input)).toBe(expected);
  });

  it.each([
    [4, '4+'],
    [5, '4+'],
    [10, '4+'],
    [100, '4+'],
  ])('buckets attempt count %s into "4+"', (input, expected) => {
    expect(bucketAttempt(input)).toBe(expected);
  });
});

describe('emitDunningEscalation', () => {
  it('emits an EMF metric with the expected dimensions and namespace', () => {
    reportMetricMock.mockClear();

    emitDunningEscalation({
      stage: 'entered',
      reason: 'card_declined',
      attemptBucket: '1',
    });

    expect(reportMetricMock).toHaveBeenCalledOnce();
    const payload = reportMetricMock.mock.calls[0][0] as Record<string, unknown>;

    expect(payload).toMatchObject({
      stage: 'entered',
      reason: 'card_declined',
      attemptBucket: '1',
      DunningEscalation: 1,
    });
    expect(payload._aws).toMatchObject({
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [['stage', 'reason', 'attemptBucket']],
          Metrics: [{ Name: 'DunningEscalation', Unit: 'Count' }],
        },
      ],
    });
    expect(typeof (payload._aws as { Timestamp: unknown }).Timestamp).toBe('number');
  });

  it.each(['entered', 'retry', 'recovered', 'canceled'] as const)(
    'passes through stage=%s unchanged',
    (stage) => {
      reportMetricMock.mockClear();

      emitDunningEscalation({ stage, reason: 'x', attemptBucket: '1' });

      expect(reportMetricMock.mock.calls[0][0]).toMatchObject({ stage });
    },
  );
});
