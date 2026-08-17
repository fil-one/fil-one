import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OrgRole } from '@filone/shared';
import type { OrgMembershipSummary } from '@filone/shared';

import { OrgSwitcher } from './OrgSwitcher';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

const memberships: OrgMembershipSummary[] = [
  { orgId: ORG_A, orgName: 'Acme', role: OrgRole.Owner },
  { orgId: ORG_B, orgName: 'Globex', role: OrgRole.Member },
];

const reload = vi.fn();

describe('OrgSwitcher', () => {
  beforeEach(() => {
    sessionStorage.clear();
    reload.mockClear();
    // Only `reload` is read on these paths, so the stub carries nothing else.
    vi.stubGlobal('location', { reload });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders nothing for a caller with one membership', () => {
    const { container } = render(
      <OrgSwitcher memberships={[memberships[0]]} activeOrgId={ORG_A} />,
    );

    // Every account today is an org of one, and a list of one is noise.
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing before /me has answered', () => {
    const { container } = render(<OrgSwitcher memberships={undefined} activeOrgId={undefined} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('lists every org the caller belongs to', () => {
    render(<OrgSwitcher memberships={memberships} activeOrgId={ORG_A} />);

    expect(screen.getByRole('button', { name: 'Acme' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Globex' })).toBeInTheDocument();
  });

  it('marks the org the server resolved as current', () => {
    render(<OrgSwitcher memberships={memberships} activeOrgId={ORG_B} />);

    expect(screen.getByRole('button', { name: 'Globex' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'Acme' })).not.toHaveAttribute('aria-current');
  });

  it('stashes the chosen org and reloads the tab', () => {
    render(<OrgSwitcher memberships={memberships} activeOrgId={ORG_A} />);

    fireEvent.click(screen.getByRole('button', { name: 'Globex' }));

    expect(sessionStorage.getItem('filone:activeOrgId')).toBe(ORG_B);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the current org is chosen', () => {
    render(<OrgSwitcher memberships={memberships} activeOrgId={ORG_A} />);

    fireEvent.click(screen.getByRole('button', { name: 'Acme' }));

    expect(reload).not.toHaveBeenCalled();
  });

  it('names an org whose profile would not read', () => {
    render(
      <OrgSwitcher
        memberships={[memberships[0], { orgId: ORG_B, orgName: '', role: OrgRole.Member }]}
        activeOrgId={ORG_A}
      />,
    );

    // `/me` leaves an unreadable profile unnamed rather than failing the whole
    // response, and an unlabeled button cannot be chosen.
    expect(screen.getByRole('button', { name: 'Untitled organization' })).toBeInTheDocument();
  });

  it('carries the e2e identifier its mount point gives it', () => {
    render(<OrgSwitcher memberships={memberships} activeOrgId={ORG_A} testId="org-switcher" />);

    expect(screen.getByTestId('org-switcher')).toBeInTheDocument();
  });
});
