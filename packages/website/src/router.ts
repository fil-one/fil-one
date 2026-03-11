import { createRouter } from '@tanstack/react-router';
import { Route as rootRoute } from './routes/__root.js';
import { Route as indexRoute } from './routes/index.js';
import { Route as authRoute } from './routes/_auth.js';
import { Route as signInRoute } from './routes/_auth/sign-in.js';
import { Route as signUpRoute } from './routes/_auth/sign-up.js';
import { Route as appRoute } from './routes/_app.js';
import { Route as dashboardRoute } from './routes/_app/dashboard.js';
import { Route as bucketsRoute } from './routes/_app/buckets.js';
import { Route as bucketDetailRoute } from './routes/_app/buckets.$bucketName.js';
import { Route as apiKeysRoute } from './routes/_app/api-keys.js';
import { Route as billingRoute } from './routes/_app/billing.js';
import { Route as settingsRoute } from './routes/_app/settings.js';
import { Route as supportRoute } from './routes/_app/support.js';
import { Route as finishSignUpRoute } from './routes/finish-sign-up.js';

const routeTree = rootRoute.addChildren([
  indexRoute,
  finishSignUpRoute,
  authRoute.addChildren([signInRoute, signUpRoute]),
  appRoute.addChildren([
    dashboardRoute,
    bucketsRoute,
    bucketDetailRoute,
    apiKeysRoute,
    billingRoute,
    settingsRoute,
    supportRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
