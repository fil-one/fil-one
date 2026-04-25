import { init, track } from '@plausible-analytics/tracker';
import { Stage } from '@filone/shared';
import { FILONE_STAGE } from './env.js';

if (FILONE_STAGE === Stage.Production) {
  init({
    domain: 'fil.one',
    captureOnLocalhost: false,
    autoCapturePageviews: true,
  });
}

export { track };
