import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DividerWithLabel } from './DividerWithLabel';

describe('DividerWithLabel', () => {
  it('renders the label text', () => {
    render(<DividerWithLabel label="or" />);
    expect(screen.getByText('or')).toBeInTheDocument();
  });
});
