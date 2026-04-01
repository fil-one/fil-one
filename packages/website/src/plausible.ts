import { init, track } from '@plausible-analytics/tracker';

init({
  domain: 'fil.one',
  captureOnLocalhost: false,
  autoCapturePageviews: true,
});

export { track };
