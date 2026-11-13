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
    const code = screen.getByText('const x = 1');
    expect(code).toBeInTheDocument();
    expect(code.closest('pre')).toHaveAttribute('tabindex', '0');
  });

  it('renders language label', () => {
    renderWithProviders(<CodeBlock code="x" language="JavaScript" />);
    expect(screen.getByText('JavaScript')).toBeInTheDocument();
  });

  it('renders copy button', () => {
    renderWithProviders(<CodeBlock code="x" />);
    expect(screen.getByLabelText('Copy code')).toBeInTheDocument();
  });

  // jsdom does no layout, so the class that sets the wrapping is what can be checked.
  it.each([
    ['wraps long lines when asked to', true, 'whitespace-pre-wrap'],
    ['scrolls long lines sideways by default', undefined, 'overflow-x-auto'],
  ])('%s', (_case, wrap, className) => {
    renderWithProviders(<CodeBlock minimal wrap={wrap} code="any-text" />);

    expect(screen.getByText('any-text').closest('pre')).toHaveClass(className);
  });
});
