import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Heading } from './Heading';

describe('Heading', () => {
  it('renders with the correct tag', () => {
    render(
      <Heading tag="h2" size="xl">
        Title
      </Heading>,
    );
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Title');
  });

  it('applies default size (xl) when no size given', () => {
    const { container } = render(<Heading tag="h1">Page Title</Heading>);
    const heading = container.querySelector('h1');
    expect(heading).toHaveClass('text-xl', 'font-medium');
  });

  it('applies text-balance when balance is true', () => {
    const { container } = render(
      <Heading tag="h3" size="lg" balance>
        Balanced
      </Heading>,
    );
    expect(container.querySelector('h3')).toHaveClass('text-balance');
  });

  it('merges className with variant classes', () => {
    const { container } = render(
      <Heading tag="h1" className="mb-4">
        With margin
      </Heading>,
    );
    const heading = container.querySelector('h1');
    expect(heading).toHaveClass('mb-4');
    expect(heading).toHaveClass('text-xl');
  });

  it('accepts ReactNode children', () => {
    render(
      <Heading tag="h2" size="lg">
        Hello <span data-testid="inner">world</span>
      </Heading>,
    );
    expect(screen.getByTestId('inner')).toHaveTextContent('world');
  });

  it('renders description paragraph when provided', () => {
    render(
      <Heading tag="h1" description="Some helpful context">
        Page Title
      </Heading>,
    );
    expect(screen.getByText('Page Title')).toBeInTheDocument();
    expect(screen.getByText('Some helpful context')).toBeInTheDocument();
  });

  it('does not render wrapper div without description', () => {
    const { container } = render(<Heading tag="h1">Solo</Heading>);
    expect(container.firstChild?.nodeName).toBe('H1');
  });

  it('wraps heading and description in a div when description is set', () => {
    const { container } = render(
      <Heading tag="h1" description="Sub text">
        Title
      </Heading>,
    );
    expect(container.firstChild?.nodeName).toBe('DIV');
    expect(container.querySelector('h1')).toBeInTheDocument();
    expect(container.querySelector('p')).toHaveTextContent('Sub text');
  });

  it('applies className to wrapper div (not h*) when description is present', () => {
    const { container } = render(
      <Heading tag="h1" description="Sub text" className="mb-6">
        Title
      </Heading>,
    );
    expect(container.firstChild).toHaveClass('mb-6');
    expect(container.querySelector('h1')).not.toHaveClass('mb-6');
  });
});
