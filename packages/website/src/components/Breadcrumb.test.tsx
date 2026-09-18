import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Breadcrumb } from './Breadcrumb';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  // `BaseLink` reads the active org's slug through this to prefix internal
  // `href`s; no org context here, so the unprefixed path is what renders.
  useParams: () => ({}),
}));

describe('Breadcrumb', () => {
  it('renders all items', () => {
    render(<Breadcrumb items={[{ label: 'Home', href: '/' }, { label: 'Page' }]} />);
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByText('Page')).toBeInTheDocument();
  });

  it('marks the last item as current page', () => {
    render(<Breadcrumb items={[{ label: 'Home', href: '/' }, { label: 'Page' }]} />);
    expect(screen.getByText('Page')).toHaveAttribute('aria-current', 'page');
  });

  it('renders links for non-last items with href', () => {
    render(<Breadcrumb items={[{ label: 'Home', href: '/' }, { label: 'Page' }]} />);
    expect(screen.getByText('Home').closest('a')).toHaveAttribute('href', '/');
  });
});
