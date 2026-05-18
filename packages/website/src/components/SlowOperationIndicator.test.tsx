import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

import { SlowOperationIndicator } from './SlowOperationIndicator.js';

describe('SlowOperationIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing before 400 ms', () => {
    render(<SlowOperationIndicator isLoading={true} operation="Creating bucket" />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders the spinner with the operation as aria-label after 400 ms', () => {
    render(<SlowOperationIndicator isLoading={true} operation="Creating bucket" />);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByLabelText('Creating bucket')).toBeInTheDocument();
  });

  it('does not show the reassurance message at 400 ms', () => {
    render(<SlowOperationIndicator isLoading={true} operation="Creating bucket" />);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByRole('status').querySelector('p')).toBeNull();
  });

  it('renders the reassurance message after 1200 ms', () => {
    render(<SlowOperationIndicator isLoading={true} operation="Creating bucket" />);
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(screen.getByRole('status').querySelector('p')).not.toBeNull();
  });
});
