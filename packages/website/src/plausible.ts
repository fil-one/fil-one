import { init, track as plausibleTrack } from '@plausible-analytics/tracker';
import { Stage } from '@filone/shared';
import { FILONE_STAGE } from './env.js';

const enabled = FILONE_STAGE === Stage.Production;

if (enabled) {
  init({
    domain: 'fil.one',
    captureOnLocalhost: false,
    autoCapturePageviews: true,
  });
}

/**
 * Safe wrapper around Plausible's `track`. No-ops outside production (where
 * `init` never ran) and never throws, so callers can fire events inline
 * without guarding or risking breaking the surrounding UI.
 */
export const track: typeof plausibleTrack = (...args) => {
  if (!enabled) return;
  try {
    plausibleTrack(...args);
  } catch (err) {
    console.error('Unexpected Plausible error:', err);
  }
};
