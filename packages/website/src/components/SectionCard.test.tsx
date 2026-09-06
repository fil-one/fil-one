import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SectionCard } from './SectionCard';

describe('SectionCard', () => {
  it('renders the title as a heading', () => {
    render(<SectionCard title="Identity">Content</SectionCard>);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Identity');
  });

  it('renders its children inside the card', () => {
    render(
      <SectionCard title="Identity">
        <p>Org name and logo</p>
      </SectionCard>,
    );
    expect(screen.getByText('Org name and logo')).toBeInTheDocument();
  });

  it('gives the card its default padding when bare is not set', () => {
    const { container } = render(<SectionCard title="Identity">Content</SectionCard>);
    const card = container.querySelector('.rounded-xl');
    expect(card).toHaveClass('p-5');
  });

  it('skips the card padding when bare is set', () => {
    const { container } = render(
      <SectionCard title="Identity" bare>
        Content
      </SectionCard>,
    );
    const card = container.querySelector('.rounded-xl');
    expect(card).not.toHaveClass('p-5');
  });
});
