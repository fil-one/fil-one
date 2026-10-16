// Member rosters for stories: the picker and the policy tab read the members
// query, and Storybook has no server to answer it.
import type { Decorator } from '@storybook/react-vite';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { OrgRole } from '@filone/shared';
import type { MemberSummary } from '@filone/shared';

import { queryKeys } from './query-client.js';

export const ADA_ID = '11111111-1111-4111-8111-111111111111';
export const BEN_ID = '22222222-2222-4222-8222-222222222222';
export const CY_ID = '33333333-3333-4333-8333-333333333333';
/** A member removed while a policy still names them. */
export const REMOVED_MEMBER_ID = '99999999-9999-4999-8999-999999999999';

export const storyRoster: MemberSummary[] = [
  { userId: ADA_ID, role: OrgRole.Owner, name: 'Ada Lovelace', email: 'ada@example.com' },
  { userId: BEN_ID, role: OrgRole.Admin, name: 'Ben Okafor', email: 'ben@example.com' },
  { userId: CY_ID, role: OrgRole.Member, email: 'cy@example.com' },
];

/** A roster long enough to scroll. */
export function buildLongRoster(size: number): MemberSummary[] {
  return Array.from({ length: size }, (_, i) => ({
    userId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    role: OrgRole.Member,
    name: `Member ${i + 1}`,
  }));
}

/**
 * Seeds one query in the story's query client. Without the staleTime the seed
 * is refetched on mount and the story shows the request failing.
 */
export function withQueryData(queryKey: readonly unknown[], data: unknown): Decorator {
  return (Story) => {
    const client = useQueryClient();
    client.setQueryDefaults(queryKey, { staleTime: Infinity });
    client.setQueryData(queryKey, data);
    return <Story />;
  };
}

/** Seeds the member list the picker and the policy tab read. */
export function withMembers(members: MemberSummary[]): Decorator {
  return withQueryData(queryKeys.members, { members });
}

/**
 * Answers every request the story makes with `respond`, for the loading and
 * error states. The stub is in place before the story's queries mount and is
 * restored when the story unmounts.
 */
export function withRequestsAnswered(respond: () => Promise<Response>): Decorator {
  return (Story) => {
    const [original] = useState(() => {
      const previous = globalThis.fetch;
      globalThis.fetch = respond as typeof fetch;
      return previous;
    });
    useEffect(
      () => () => {
        globalThis.fetch = original;
      },
      [original],
    );
    return <Story />;
  };
}

export const neverAnswers = () => new Promise<Response>(() => {});
export const answersUnavailable = () =>
  Promise.resolve(
    new Response(JSON.stringify({ message: 'Service unavailable' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    }),
  );
