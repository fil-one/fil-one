import { describe, it, expect, vi, afterEach } from 'vitest';

import { cancelGuardedWork, holdLeaveGuard, leaveGuardedWork } from './use-warn-before-unload.js';

describe('the leave guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // For work the caller has already made pointless, such as an upload into an
  // org the user has just left: there is nothing to ask.
  it('cancels every held piece of work without asking', () => {
    const confirm = vi.spyOn(window, 'confirm');
    const first = vi.fn();
    const second = vi.fn();
    const releaseFirst = holdLeaveGuard(first);
    const releaseSecond = holdLeaveGuard(second);

    cancelGuardedWork();

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    releaseFirst();
    releaseSecond();
  });

  // Leaving an org cancels its upload and then moves the tab. The upload's own
  // cleanup, which releases its guard, runs later; the move must not ask about
  // work that was already stopped, or a Cancel there strands the tab on the
  // org it just left.
  it('asks nothing about cancelled work whose own cleanup has not run yet', () => {
    const confirm = vi.spyOn(window, 'confirm');
    holdLeaveGuard(vi.fn());

    cancelGuardedWork();

    expect(leaveGuardedWork()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("releases a cancelled guard's beforeunload warning too", () => {
    holdLeaveGuard(vi.fn());
    cancelGuardedWork();

    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('leaves nothing to ask about once the work has released its guard', () => {
    const confirm = vi.spyOn(window, 'confirm');
    const release = holdLeaveGuard(vi.fn());
    release();

    expect(leaveGuardedWork()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });
});
