import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CodeBlock } from './CodeBlock';

describe('CodeBlock', () => {
  it('renders code content', () => {
    render(<CodeBlock code="const x = 1" />);
    expect(screen.getByText('const x = 1')).toBeInTheDocument();
  });

  it('renders language label', () => {
    render(<CodeBlock code="x" language="JavaScript" />);
    expect(screen.getByText('JavaScript')).toBeInTheDocument();
  });

  it('renders copy button', () => {
    render(<CodeBlock code="x" />);
    expect(screen.getByLabelText('Copy code')).toBeInTheDocument();
  });
});
