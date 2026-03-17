import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToastProvider } from './ToastProvider';
import { useToast } from './useToast';

function TestComponent() {
  const { toast } = useToast();
  return <button onClick={() => toast.success('Success message')}>Show toast</button>;
}

describe('Toast', () => {
  it('shows a toast message', () => {
    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('Show toast'));
    expect(screen.getByText('Success message')).toBeInTheDocument();
  });

  it('dismisses toast on close click', () => {
    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('Show toast'));
    expect(screen.getByText('Success message')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Dismiss notification'));
    expect(screen.queryByText('Success message')).not.toBeInTheDocument();
  });
});
