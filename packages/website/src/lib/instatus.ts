import type { BadgeColor } from '../components/Badge.js';

export const INSTATUS_PAGE_URL = 'https://fil-one.instatus.com';
export const INSTATUS_SUMMARY_URL = `${INSTATUS_PAGE_URL}/summary.json`;

export type InstatusSummary = {
  page: { name: string; url: string; status: string };
};

type StatusDisplay = { color: BadgeColor; label: string };

const STATUS_DISPLAY: Record<string, StatusDisplay> = {
  UP: { color: 'green', label: 'All systems operational' },
  HASISSUES: { color: 'red', label: 'Service disruption' },
  UNDERMAINTENANCE: { color: 'blue', label: 'Under maintenance' },
};

const FALLBACK: StatusDisplay = { color: 'grey', label: 'Status unavailable' };

export function getStatusDisplay(status: string): StatusDisplay {
  return STATUS_DISPLAY[status] ?? FALLBACK;
}

export async function fetchInstatusSummary(): Promise<InstatusSummary> {
  const response = await fetch(INSTATUS_SUMMARY_URL);
  if (!response.ok) {
    throw new Error(`Instatus summary request failed: ${response.status}`);
  }
  return (await response.json()) as InstatusSummary;
}
