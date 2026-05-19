import { useEffect, useState } from 'react';

export type SlowOperationIndicatorState = {
  showSpinner: boolean;
  showMessage: boolean;
};

// 400 ms: above flicker territory and the eye's reliable "I noticed a wait" threshold (~100 ms),
// below the cross-region baseline that would make the spinner the default state.
// 1200 ms: just past Nielsen's 1 s "flow of thought" boundary (when users start actively waiting)
const SPINNER_DELAY_MS = 400;
const MESSAGE_DELAY_MS = 1200;

export function useSlowOperationIndicator(isLoading: boolean): SlowOperationIndicatorState {
  const [showSpinner, setShowSpinner] = useState(false);
  const [showMessage, setShowMessage] = useState(false);

  useEffect(() => {
    if (!isLoading) {
      setShowSpinner(false);
      setShowMessage(false);
      return;
    }
    const spinnerTimer = setTimeout(() => setShowSpinner(true), SPINNER_DELAY_MS);
    const messageTimer = setTimeout(() => setShowMessage(true), MESSAGE_DELAY_MS);
    return () => {
      clearTimeout(spinnerTimer);
      clearTimeout(messageTimer);
    };
  }, [isLoading]);

  return { showSpinner, showMessage };
}
