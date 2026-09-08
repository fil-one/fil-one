import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OrgRole } from '@filone/shared';
import type { OrgMembershipSummary } from '@filone/shared';

import { OrgSwitcher } from './OrgSwitcher';

// `switchToOrg` imports the router dynamically to resolve a slug and
// navigate; these cases are about the stash and the latch, not the real
// router, so this is a controllable stand-in.
const routerNavigate = vi.fn();
vi.mock('../router.js', () => ({
  router: { navigate: (...args: unknown[]) => routerNavigate(...args) },
}));

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

const memberships: OrgMembershipSummary[] = [
  { orgId: ORG_A, orgName: 'Acme', slug: 'acme', role: OrgRole.Owner },
  { orgId: ORG_B, orgName: 'Globex', slug: 'globex', role: OrgRole.Member },
];

const assign = vi.fn();
const reload = vi.fn();

describe('OrgSwitcher', () => {
  beforeEach(() => {
    sessionStorage.clear();
    assign.mockClear();
    reload.mockClear();
    routerNavigate.mockReset();
    // Pending forever by default: the switcher's rows only re-enable once the
    // navigation settles, and these cases are about the window while it has
    // not.
    routerNavigate.mockImplementation(() => new Promise(() => {}));
    // Only `assign` and `reload` are read on these paths, so the stub carries
    // nothing else.
    vi.stubGlobal('location', { assign, reload });
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

  it('lists them by name', () => {
    render(
      <OrgSwitcher
        memberships={[
          { orgId: ORG_A, orgName: 'Zenith', slug: 'zenith', role: OrgRole.Owner },
          { orgId: ORG_B, orgName: 'Acme', slug: 'acme', role: OrgRole.Member },
        ]}
        activeOrgId={ORG_A}
      />,
    );

    // The server returns them in key order, which is org id order — arbitrary
    // to everyone but the database. `textContent` would also pick up the
    // aria-hidden avatar's initial, so the accessible name is what's compared.
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveAccessibleName('Acme');
    expect(buttons[1]).toHaveAccessibleName('Zenith');
  });

  it('scrolls rather than growing past its dropdown', () => {
    render(<OrgSwitcher memberships={memberships} activeOrgId={ORG_A} testId="org-switcher" />);

    // The backend answers up to 100 memberships and neither dropdown scrolls.
    expect(screen.getByTestId('org-switcher').className).toContain('overflow-y-auto');
  });

  it('marks the org the server resolved as current', () => {
    render(<OrgSwitcher memberships={memberships} activeOrgId={ORG_B} />);

    const current = screen.getByRole('button', { name: 'Globex' });
    expect(current).toHaveAttribute('aria-current', 'true');
    // Its inertness is designed, so it is announced rather than left for a
    // click that does nothing to reveal.
    expect(current).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Acme' })).not.toHaveAttribute('aria-current');
  });

  it('speaks menu inside a menu', () => {
    render(<OrgSwitcher memberships={memberships} activeOrgId={ORG_B} inMenu />);

    // The mobile panel is a `role="menu"` whose children have to be menu items;
    // a plain button there is announced as one and disagrees with its siblings.
    const current = screen.getByRole('menuitemradio', { name: 'Globex' });
    expect(current).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: 'Acme' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('stashes the chosen org and navigates into it', async () => {
    render(<OrgSwitcher memberships={memberships} activeOrgId={ORG_A} />);

    fireEvent.click(screen.getByRole('button', { name: 'Globex' }));

    expect(sessionStorage.getItem('filone:activeOrgId')).toBe(ORG_B);
    // Not the current URL: bucket names and key ids are org-scoped, so
    // navigating in place would greet the user with a not-found page.
    // `switchToOrg` resolves the router dynamically, a microtask past the
    // click, before calling it.
    await vi.waitFor(() => expect(routerNavigate).toHaveBeenCalled());
  });

  it('goes inert once a switch is under way', async () => {
    render(<OrgSwitcher memberships={memberships} activeOrgId={ORG_A} />);
    const target = screen.getByRole('button', { name: 'Globex' });

    fireEvent.click(target);
    fireEvent.click(screen.getByRole('button', { name: 'Acme' }));

    // The navigation takes as long as it takes, and a second click in that
    // window would stash a third org while the second one's navigation is in
    // flight.
    expect(target).toHaveAttribute('aria-busy', 'true');
    await vi.waitFor(() => expect(routerNavigate).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem('filone:activeOrgId')).toBe(ORG_B);
  });

  it('does nothing when the current org is chosen', () => {
    render(<OrgSwitcher memberships={memberships} activeOrgId={ORG_A} />);

    fireEvent.click(screen.getByRole('button', { name: 'Acme' }));

    expect(routerNavigate).not.toHaveBeenCalled();
  });

  it('closes the host panel on a real switch, so its rows never blink out from under an open menu', () => {
    const onClose = vi.fn();
    render(<OrgSwitcher memberships={memberships} activeOrgId={ORG_A} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Globex' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close the host panel when the current org is chosen — there is nothing to switch to', () => {
    const onClose = vi.fn();
    render(<OrgSwitcher memberships={memberships} activeOrgId={ORG_A} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Acme' }));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('names an org whose profile would not read', () => {
    render(
      <OrgSwitcher
        memberships={[
          memberships[0],
          { orgId: ORG_B, orgName: '', slug: 'org-b', role: OrgRole.Member },
        ]}
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
