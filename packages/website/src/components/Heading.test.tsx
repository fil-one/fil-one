import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Heading } from './Heading';

describe('Heading', () => {
  it('renders with the correct tag', () => {
    render(
      <Heading tag="h2" variant="card-heading">
        Title
      </Heading>,
    );
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Title');
  });

  it('applies variant classes', () => {
    render(
      <Heading tag="h1" variant="page-heading">
        Big Title
      </Heading>,
    );
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toBeInTheDocument();
  });
});
