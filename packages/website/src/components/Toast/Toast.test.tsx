import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToastProvider } from './ToastProvider';
import { useToast } from './useToast';

function TestComponent() {
  const { toast } = useToast();
  return <button onClick={() => toast.success('Success message')}>Show toast</button>;
}

function RichTestComponent() {
  const { toast } = useToast();
  return (
    <button
      onClick={() =>
        toast.error(
          <>
            Bucket is not empty — <a href="https://docs.fil.one">how to empty a bucket</a>
          </>,
        )
      }
    >
      Show rich toast
    </button>
  );
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

  // Messages are ReactNode so an error can link to the docs that explain the fix.
  it('renders a message containing a link', () => {
    render(
      <ToastProvider>
        <RichTestComponent />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('Show rich toast'));
    expect(screen.getByRole('link', { name: 'how to empty a bucket' })).toHaveAttribute(
      'href',
      'https://docs.fil.one',
    );
  });
});
