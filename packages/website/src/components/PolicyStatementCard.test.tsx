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

  it.each([
    ['read', 's3:GetObject', 'bg-brand-50'],
    ['list', 's3:ListBucket', 'bg-brand-50'],
    ['write', 's3:PutObject', 'bg-amber-50'],
    ['delete', 's3:DeleteObject', 'bg-red-50'],
    ['protect', 's3:GetObjectRetention', 'bg-red-50'],
  ] as const)('colours the %s group badge by risk', (group, action, colourClass) => {
    renderCard({ ...allowTeam, Action: [action] });

    expect(screen.getByTestId(`policy-actions-${group}`)).toHaveClass(colourClass);
  });

  it('colours the All actions badge red', () => {
    renderCard({ ...allowTeam, Action: ['s3:*'] });

    expect(screen.getByText('All actions')).toHaveClass('bg-red-50');
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

  it('shows a single "All actions" badge for s3:*', () => {
    renderCard({ ...allowTeam, Action: ['s3:*'] });

    expect(screen.getByText('All actions')).toBeInTheDocument();
    expect(screen.queryByTestId(/^policy-actions-/)).not.toBeInTheDocument();
  });

  it('shows no actions menu without onEdit and onRemove', () => {
    renderCard(allowTeam);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('calls onEdit when Edit statement is chosen from the actions menu', () => {
    const onEdit = vi.fn();
    renderCard(allowTeam, { onEdit });

    fireEvent.click(screen.getByRole('button', { name: 'Actions for team' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit statement' }));

    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('calls onRemove when Remove statement is chosen from the actions menu', () => {
    const onRemove = vi.fn();
    renderCard(allowTeam, { onRemove });

    fireEvent.click(screen.getByRole('button', { name: 'Actions for team' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove statement' }));

    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('offers only Edit statement when only onEdit is given', () => {
    renderCard(allowTeam, { onEdit: () => {} });

    fireEvent.click(screen.getByRole('button', { name: 'Actions for team' }));

    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toStrictEqual([
      'Edit statement',
    ]);
  });
});
