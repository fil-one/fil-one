import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { PolicyStatement } from '@filone/shared';

import { PolicyStatementCard } from './PolicyStatementCard.js';

const names: Record<string, string> = { a: 'Ada', b: 'Ben', c: 'Cy', d: 'Di' };
const memberName = (id: string) => names[id];

function renderCard(
  statement: PolicyStatement,
  props: Partial<React.ComponentProps<typeof PolicyStatementCard>> = {},
) {
  return render(
    <PolicyStatementCard statement={statement} index={0} memberName={memberName} {...props} />,
  );
}

describe('PolicyStatementCard', () => {
  it('names the effect, the members, and the action groups', () => {
    renderCard({
      sid: 'team',
      effect: 'allow',
      principal: ['a', 'b'],
      action: ['s3:GetObject', 's3:ListBucket', 's3:PutObject'],
    });

    expect(screen.getByText('Allow')).toBeInTheDocument();
    expect(screen.getByText('team')).toBeInTheDocument();
    expect(
      screen.getByText('Ada and Ben can read objects, list objects, and write objects'),
    ).toBeInTheDocument();
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('Ben')).toBeInTheDocument();
    expect(screen.getByTestId('policy-actions-read')).toBeInTheDocument();
    expect(screen.getByTestId('policy-actions-list')).toBeInTheDocument();
    expect(screen.getByTestId('policy-actions-write')).toBeInTheDocument();
    expect(screen.queryByTestId('policy-actions-delete')).not.toBeInTheDocument();
  });

  it('labels a statement with no sid by its position and shows a deny in red', () => {
    renderCard({ effect: 'deny', principal: '*', action: ['s3:DeleteObject'] }, { index: 2 });

    expect(screen.getByText('Deny')).toBeInTheDocument();
    expect(
      screen.getByText('Everyone in this organization cannot delete objects'),
    ).toBeInTheDocument();
    expect(screen.getByText('Everyone in this organization')).toBeInTheDocument();
  });

  it('folds members past the third into one badge and names an unknown member honestly', () => {
    renderCard({ effect: 'allow', principal: ['a', 'b', 'c', 'd', 'gone'], action: ['s3:*'] });

    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('Cy')).toBeInTheDocument();
    expect(screen.queryByText('Di')).not.toBeInTheDocument();
    expect(screen.getByTestId('policy-more-members')).toHaveTextContent('+2 more');
    expect(screen.getByText('All actions')).toBeInTheDocument();
    // The unknown member is in the folded list, which the tooltip carries.
    expect(screen.queryByText('Unknown member')).not.toBeInTheDocument();
  });

  it('offers edit and remove only when given something to call', () => {
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    const statement: PolicyStatement = {
      effect: 'allow',
      principal: ['a'],
      action: ['s3:GetObject'],
    };

    const { rerender } = renderCard(statement);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    rerender(
      <PolicyStatementCard
        statement={statement}
        index={0}
        memberName={memberName}
        onEdit={onEdit}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Statement 1' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit statement' }));
    expect(onEdit).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Statement 1' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove statement' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
