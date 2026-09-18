// Pure mappings between the Management API contract's wire shapes and the
// ServiceOrchestrator interface, kept apart from the orchestrator so each stays
// readable on its own.

import type { TenantStatus } from '@filone/shared';
import type { Metrics } from '@filone/orchestrator-client';
import type { StorageUsageSample } from '../service-orchestrator.ts';

const MANAGEMENT_TENANT_STATUSES: readonly TenantStatus[] = ['active', 'write-locked', 'disabled'];

// The contract's status enum is closed, but defend against noncompliant
// orchestrators: unknown values surface as `undefined` rather than leaking a
// string TenantStatus doesn't model.
export function normalizeStatus(status: string | undefined): TenantStatus | undefined {
  return MANAGEMENT_TENANT_STATUSES.find((s) => s === status);
}

// The interface expresses sampling as an interval like '1d'/'1h'; the
// contract only accepts `<integer>h` windows. Same permissive posture as
// aurora: convert day intervals, pass hour intervals through, and let the API
// reject anything else with a 400.
export function mapIntervalToWindow(interval: string): string {
  const days = /^(\d+)d$/.exec(interval);
  if (days) return `${Number(days[1]) * 24}h`;
  return interval;
}

export function mapStorageSamples(metrics: Metrics): StorageUsageSample[] {
  return metrics.storage.samples.map((s) => ({
    timestamp: new Date(s.timestamp).toISOString(),
    bytesUsed: s.bytesUsed,
    objectCount: s.objectCount,
  }));
}

// Pulls the human-readable message out of the contract's error body
// (`{ message, code? }`) returned in the SDK result's `error` field.
export function extractApiMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'message' in body) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return undefined;
}
