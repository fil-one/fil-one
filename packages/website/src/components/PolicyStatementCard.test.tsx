import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { PolicyStatement } from '@filone/shared';
import { ROSTER_ADMINS_SID, ROSTER_CREATOR_SID, ROSTER_OWNERS_SID } from '@filone/shared';

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
    expect(screen.getByText('Statement 3')).toBeInTheDocument();
    expect(screen.getByText('Everyone in this organization')).toBeInTheDocument();
  });

  it('titles a roster statement by its label and any other by its sid', () => {
    const titles = [ROSTER_OWNERS_SID, ROSTER_ADMINS_SID, ROSTER_CREATOR_SID, 'team'].map((sid) => {
      const { unmount } = renderCard(
        { sid, effect: 'allow', principal: ['a'], action: ['s3:GetObject'] },
        { onEdit: () => {} },
      );
      const label = screen.getByRole('button', { name: /^Edit / }).getAttribute('aria-label');
      unmount();
      return label;
    });

    expect(titles).toEqual(['Edit Owners', 'Edit Admins', 'Edit Bucket creator', 'Edit team']);
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
    fireEvent.click(screen.getByRole('button', { name: 'Edit Statement 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Statement 1' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
