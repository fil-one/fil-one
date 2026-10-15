import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { PolicyStatement } from '@filone/shared';

import { PolicyStatementCard } from './PolicyStatementCard.js';

const memberNamesById: Record<string, string> = { a: 'Ada', b: 'Ben', c: 'Cy', d: 'Di' };
const getMemberName = (id: string) => memberNamesById[id];

const allowTeam: PolicyStatement = {
  Sid: 'team',
  Effect: 'Allow',
  Principal: ['a', 'b'],
  Action: ['s3:GetObject', 's3:ListBucket', 's3:PutObject'],
};

function renderCard(
  statement: PolicyStatement,
  props: Partial<React.ComponentProps<typeof PolicyStatementCard>> = {},
) {
  return render(
    <PolicyStatementCard
      statement={statement}
      index={0}
      getMemberName={getMemberName}
      {...props}
    />,
  );
}

describe('PolicyStatementCard', () => {
  it('shows an Allow badge for an Allow statement', () => {
    renderCard(allowTeam);

    expect(screen.getByText('Allow')).toBeInTheDocument();
  });

  it('titles a statement by its Sid', () => {
    renderCard(allowTeam);

    expect(screen.getByText('team')).toBeInTheDocument();
  });

  it('shows one badge per named member', () => {
    renderCard(allowTeam);

    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('Ben')).toBeInTheDocument();
  });

  it('shows one badge per action group the statement touches', () => {
    renderCard(allowTeam);

    const groupTestIds = screen
      .getAllByTestId(/^policy-actions-/)
      .map((badge) => badge.getAttribute('data-testid'));
    expect(groupTestIds).toStrictEqual([
      'policy-actions-read',
      'policy-actions-list',
      'policy-actions-write',
    ]);
  });

  it('titles a statement with no Sid "Statement N" by its 1-based position', () => {
    renderCard({ ...allowTeam, Sid: undefined }, { index: 2 });

    expect(screen.getByText('Statement 3')).toBeInTheDocument();
  });

  it('shows a Deny badge for a Deny statement', () => {
    renderCard({ ...allowTeam, Effect: 'Deny' });

    expect(screen.getByText('Deny')).toBeInTheDocument();
  });

  it('shows "Everyone in this organization" when Principal is "*"', () => {
    renderCard({ ...allowTeam, Principal: '*' });

    expect(screen.getByText('Everyone in this organization')).toBeInTheDocument();
  });

  it('shows the first three members and folds the rest into a "+N more" badge', () => {
    renderCard({ ...allowTeam, Principal: ['a', 'b', 'c', 'd', 'e'] });

    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('Ben')).toBeInTheDocument();
    expect(screen.getByText('Cy')).toBeInTheDocument();
    expect(screen.queryByText('Di')).not.toBeInTheDocument();
    expect(screen.getByTestId('policy-more-members')).toHaveTextContent('+2 more');
  });

  it('shows "Unknown member" for a user id with no known name', () => {
    renderCard({ ...allowTeam, Principal: ['gone'] });

    expect(screen.getByText('Unknown member')).toBeInTheDocument();
  });

  it('sets each unknown member apart with a dashed badge', () => {
    renderCard({ ...allowTeam, Principal: ['a', 'gone', 'also-gone'] });

    expect(screen.getAllByText('Unknown member')).toHaveLength(2);
    expect(screen.getAllByTestId('policy-unknown-member')).toHaveLength(2);
    expect(screen.getByText('Ada')).not.toHaveClass('border-dashed');
  });

  it('shows a single "All actions" badge for s3:*', () => {
    renderCard({ ...allowTeam, Action: ['s3:*'] });

    expect(screen.getByText('All actions')).toBeInTheDocument();
    expect(screen.queryByTestId(/^policy-actions-/)).not.toBeInTheDocument();
  });

  it('shows no edit or remove button without onEdit and onRemove', () => {
    renderCard(allowTeam);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('calls onEdit when the Edit button is clicked', () => {
    const onEdit = vi.fn();
    renderCard(allowTeam, { onEdit });

    fireEvent.click(screen.getByRole('button', { name: 'Edit team' }));

    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('calls onRemove when the Remove button is clicked', () => {
    const onRemove = vi.fn();
    renderCard(allowTeam, { onRemove });

    fireEvent.click(screen.getByRole('button', { name: 'Remove team' }));

    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('shows only the Edit button when only onEdit is given', () => {
    renderCard(allowTeam, { onEdit: () => {} });

    expect(
      screen.getAllByRole('button').map((button) => button.getAttribute('aria-label')),
    ).toStrictEqual(['Edit team']);
  });
});
