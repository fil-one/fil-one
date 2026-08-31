import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ActiveOrgNotice } from './ActiveOrgNotice';
import { ToastProvider } from './Toast/ToastProvider';

function renderNotice() {
  return render(
    <ToastProvider>
      <ActiveOrgNotice />
    </ToastProvider>,
  );
}

describe('ActiveOrgNotice', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('says so when the load followed a reconcile', () => {
    sessionStorage.setItem('filone:activeOrgReconciled', '1');

    renderNotice();

    // Without this, a header a proxy keeps stripping turns every switcher click
    // into a reload that lands back where it started.
    expect(screen.getByTestId('toast')).toHaveTextContent('your own organization');
  });

  it('says nothing on an ordinary load', () => {
    renderNotice();

    expect(screen.queryByTestId('toast')).not.toBeInTheDocument();
  });

  it('says it once', () => {
    sessionStorage.setItem('filone:activeOrgReconciled', '1');
    renderNotice().unmount();

    renderNotice();

    // The flag is spent by the load that read it, not carried into every later
    // page in the session.
    expect(screen.queryByTestId('toast')).not.toBeInTheDocument();
  });
});
