import * as Sentry from '@sentry/react';
import { FILONE_STAGE } from './env.js';

Sentry.init({
  dsn: 'https://a67c49004e3562393b7c63deedcbb951@o4507369657991168.ingest.us.sentry.io/4511144562655232',
  environment: FILONE_STAGE,
  enableLogs: true,
});
