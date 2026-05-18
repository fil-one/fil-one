export type MetricUnit =
  | 'Seconds'
  | 'Microseconds'
  | 'Milliseconds'
  | 'Bytes'
  | 'Kilobytes'
  | 'Megabytes'
  | 'Gigabytes'
  | 'Terabytes'
  | 'Bits'
  | 'Kilobits'
  | 'Megabits'
  | 'Gigabits'
  | 'Terabits'
  | 'Percent'
  | 'Count'
  | 'Bytes/Second'
  | 'Kilobytes/Second'
  | 'Megabytes/Second'
  | 'Gigabytes/Second'
  | 'Terabytes/Second'
  | 'Bits/Second'
  | 'Kilobits/Second'
  | 'Megabits/Second'
  | 'Gigabits/Second'
  | 'Terabits/Second'
  | 'Count/Second'
  | 'None';

export interface MetricEvent {
  _aws: {
    Timestamp: number;
    CloudWatchMetrics: {
      Namespace: 'FilOne';
      Dimensions: string[][];
      Metrics: { Name: string; Unit: MetricUnit }[];
    }[];
  };
  [key: string]: unknown;
}

/**
 * Report a metric data point via CloudWatch Embedded Metric Format (EMF).
 *
 * Writes directly to stdout instead of using console.log() because Lambda's
 * JSON log format wraps console.log output in a JSON envelope, which
 * double-encodes the EMF and prevents CloudWatch from extracting metrics.
 */
export function reportMetric(event: MetricEvent): void {
  process.stdout.write(JSON.stringify(event) + '\n');
}
