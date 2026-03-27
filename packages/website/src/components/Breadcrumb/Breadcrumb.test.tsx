import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Breadcrumb } from './Breadcrumb';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
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

  it('renders nav with aria-label', () => {
    render(<Breadcrumb items={[{ label: 'Home' }]} />);
    expect(screen.getByLabelText('Breadcrumb')).toBeInTheDocument();
  });
});
