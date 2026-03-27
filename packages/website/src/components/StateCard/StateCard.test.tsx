import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { StateCard } from './StateCard';

describe('StateCard', () => {
  it('renders children', () => {
    render(<StateCard border="solid">Card content</StateCard>);
    expect(screen.getByText('Card content')).toBeInTheDocument();
  });

  it('applies dashed border', () => {
    const { container } = render(<StateCard border="dashed">Content</StateCard>);
    expect(container.firstChild).toHaveClass('border-dashed');
  });

  it('accepts className prop', () => {
    const { container } = render(
      <StateCard border="solid" className="my-4">
        Content
      </StateCard>,
    );
    expect(container.firstChild).toHaveClass('my-4');
  });
});
