import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CodeBlock } from './CodeBlock';
import { ToastProvider } from './Toast/ToastProvider';

function renderWithProviders(ui: React.ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

describe('CodeBlock', () => {
  it('renders code content', () => {
    renderWithProviders(<CodeBlock code="const x = 1" />);
    expect(screen.getByText('const x = 1')).toBeInTheDocument();
  });

  it('renders language label', () => {
    renderWithProviders(<CodeBlock code="x" language="JavaScript" />);
    expect(screen.getByText('JavaScript')).toBeInTheDocument();
  });

  it('renders copy button', () => {
    renderWithProviders(<CodeBlock code="x" />);
    expect(screen.getByLabelText('Copy code')).toBeInTheDocument();
  });
});
