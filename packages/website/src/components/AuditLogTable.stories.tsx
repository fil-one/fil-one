import type { Meta, StoryObj } from '@storybook/react-vite';
import { OrgRole } from '@filone/shared';
import type { AuditEvent } from '@filone/shared';

import { AuditLogTable } from './AuditLogTable';

function event(overrides: Partial<AuditEvent>): AuditEvent {
  return {
    eventId: 'evt-1',
    type: 'org.renamed',
    actor: { kind: 'user', id: 'user-1', email: 'ada@example.com' },
    orgId: 'org-1',
    subject: 'org:org-1',
    details: { name: 'Acme Storage', previousName: 'Acme' },
    createdAt: '2026-08-15T12:00:00.000Z',
    ttl: 1_800_000_000,
    ...overrides,
  } as AuditEvent;
}

/**
 * A week of an org's history, covering every row shape the table renders: a
 * plain change, a membership change with a payload worth expanding, an actor
 * with no verified address, and both halves of a two-phase key flow.
 */
const EVENTS: AuditEvent[] = [
  event({
    eventId: 'evt-1',
    type: 'member.role_changed',
    subject: 'user:user-2',
    details: { role: OrgRole.Admin, previousRole: OrgRole.Member },
    createdAt: '2026-08-15T12:00:00.000Z',
  }),
  event({
    eventId: 'evt-2',
    type: 'key.created',
    subject: 'key:MPLE',
    details: { keyKind: 's3', keyName: 'ci-deploy', region: 'eu-west-1', keyIdSuffix: 'MPLE' },
    phase: 'completion',
    correlationId: 'corr-1',
    outcome: 'succeeded',
    createdAt: '2026-08-14T09:30:00.000Z',
  }),
  // The dangling half a crash between a vendor call and its local write leaves
  // behind: the most operationally interesting row the log can hold.
  event({
    eventId: 'evt-3',
    type: 'key.created',
    subject: 'org:org-1',
    details: { keyKind: 's3', keyName: 'ci-deploy' },
    phase: 'intent',
    correlationId: 'corr-1',
    createdAt: '2026-08-14T09:29:58.000Z',
  }),
  event({
    eventId: 'evt-4',
    type: 'member.invited',
    subject: 'invite:inv-1',
    details: { inviteId: 'inv-1', email: 'grace@example.com', role: OrgRole.Member },
    createdAt: '2026-08-13T16:02:00.000Z',
  }),
  // An account that has been deleted leaves its events behind with no profile to
  // resolve, so the row shows the id the envelope carries.
  event({
    eventId: 'evt-5',
    type: 'member.removed',
    actor: { kind: 'user', id: 'user-9' },
    subject: 'user:user-3',
    details: { role: OrgRole.ReadOnly, revokedInvitations: 2 },
    createdAt: '2026-08-12T11:45:00.000Z',
  }),
  event({ eventId: 'evt-6', createdAt: '2026-08-11T08:00:00.000Z' }),
];

const meta: Meta<typeof AuditLogTable> = {
  title: 'Components/AuditLogTable',
  component: AuditLogTable,
  args: {
    events: EVENTS,
    isPending: false,
    filtered: false,
    expanded: null,
    onToggleExpand: () => {},
    onFilterActor: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof AuditLogTable>;

export const Default: Story = {};

/** A row opened to show its payload, which is why the column exists. */
export const RowExpanded: Story = {
  args: { expanded: 'evt-1' },
};

export const Loading: Story = {
  args: { events: undefined, isPending: true },
};

/** Nothing has happened yet, so the state says what will land here. */
export const Empty: Story = {
  args: { events: [] },
};

/** Nothing matched, so the state names the filters to loosen. */
export const EmptyUnderFilters: Story = {
  args: { events: [], filtered: true },
};

export const Failed: Story = {
  args: { events: undefined, error: new Error('The service is temporarily unavailable.') },
};
