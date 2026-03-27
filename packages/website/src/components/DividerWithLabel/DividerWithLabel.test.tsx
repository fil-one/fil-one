import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { DividerWithLabel } from './DividerWithLabel';

describe('DividerWithLabel', () => {
  it('renders the label text', () => {
    render(<DividerWithLabel label="or" />);
    expect(screen.getByText('or')).toBeInTheDocument();
  });

  it('accepts className prop', () => {
    const { container } = render(<DividerWithLabel label="or" className="my-4" />);
    expect(container.firstChild).toHaveClass('my-4');
  });
});
