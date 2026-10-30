import { init, track as plausibleTrack } from '@plausible-analytics/tracker';
import { Stage } from '@filone/shared';
import { FILONE_STAGE } from './env.js';
import { scrubTrackedPayload } from './lib/url-scrub.js';

const enabled = FILONE_STAGE === Stage.Production;

if (enabled) {
  init({
    domain: 'fil.one',
    captureOnLocalhost: false,
    autoCapturePageviews: true,
    // The invitation accept link carries a single-use token in its fragment,
    // and this tracker captures its first pageview when the module above is
    // evaluated — before any route code has had a chance to strip it.
    transformRequest: scrubTrackedPayload,
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
