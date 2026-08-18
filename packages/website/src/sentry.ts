import * as Sentry from '@sentry/react';
import { FILONE_STAGE } from './env.js';
import { scrubBreadcrumb, scrubEvent } from './lib/sentry-scrub.js';

Sentry.init({
  dsn: 'https://a67c49004e3562393b7c63deedcbb951@o4507369657991168.ingest.us.sentry.io/4511144562655232',
  environment: FILONE_STAGE,
  enableLogs: true,
  // The invitation accept link carries its single-use token in the URL fragment,
  // which is exactly the shape that keeps it out of logs — until an error
  // reporter captures the URL. Both hooks redact it: breadcrumbs because
  // `history.replaceState` leaves one naming the URL it navigated away from, and
  // events because the report carries the location it was raised at.
  beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  beforeSend: (event) => scrubEvent(event),
});
