import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { UserMenu } from './UserMenu';

// `BaseLink` renders through `@tanstack/react-router`'s `Link`, which throws
// outside a mounted router; these cases are about the menu's own contents,
// not routing, so a plain anchor stands in — same stand-in `SidebarNav.test.tsx`
// uses for the same reason.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useParams: () => ({}),
}));

const logout = vi.fn();
vi.mock('../lib/api.js', () => ({ logout: (...args: unknown[]) => logout(...args) }));

function renderMenu(overrides: Partial<React.ComponentProps<typeof UserMenu>> = {}) {
  return render(
    <UserMenu
      src={undefined}
      initial="A"
      displayName="Ada Lovelace"
      collapsed={false}
      testId="user-menu-button"
      {...overrides}
    />,
  );
}

describe('UserMenu', () => {
  it('is closed until the trigger is clicked', () => {
    renderMenu();

    expect(screen.queryByText('Settings')).not.toBeInTheDocument();
  });

  it('names the trigger after the signed-in person', () => {
    renderMenu();

    expect(screen.getByTestId('user-menu-button')).toHaveAccessibleName(
      'User menu for Ada Lovelace',
    );
  });

  it('shows the display name when not collapsed', () => {
    renderMenu();

    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('opens the menu on click and lists its actions', () => {
    renderMenu();

    fireEvent.click(screen.getByTestId('user-menu-button'));

    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByText('Support')).toBeInTheDocument();
    expect(screen.getByText('Documentation')).toBeInTheDocument();
    expect(screen.getByText('Log out')).toBeInTheDocument();
  });

  it('logs out when Log out is clicked', () => {
    renderMenu();

    fireEvent.click(screen.getByTestId('user-menu-button'));
    fireEvent.click(screen.getByText('Log out'));

    expect(logout).toHaveBeenCalledTimes(1);
  });
});
