import { createRouter } from '@tanstack/react-router';
import { Route as rootRoute } from './routes/__root.js';
import { Route as indexRoute } from './routes/index.js';
import { Route as authRoute } from './routes/_auth.js';
import { Route as signInRoute } from './routes/_auth/sign-in.js';
import { Route as signUpRoute } from './routes/_auth/sign-up.js';
import { Route as loginErrorRoute } from './routes/_auth/login-error.js';
import { Route as appRoute } from './routes/_app.js';
import { Route as dashboardRoute } from './routes/_app/dashboard.js';
import { Route as bucketsRoute } from './routes/_app/buckets.js';
import { Route as createBucketRoute } from './routes/_app/buckets.create.js';
import { Route as bucketDetailRoute } from './routes/_app/buckets.$bucketName.js';
import { Route as objectDetailRoute } from './routes/_app/buckets.$bucketName.objects.$objectKey.js';
import { Route as uploadObjectRoute } from './routes/_app/buckets.$bucketName.upload.js';
import { Route as apiKeysRoute } from './routes/_app/api-keys.js';
import { Route as createApiKeyRoute } from './routes/_app/api-keys.create.js';
import { Route as billingRoute } from './routes/_app/billing.js';
import { Route as settingsRoute } from './routes/_app/settings.js';
import { Route as supportRoute } from './routes/_app/support.js';
import { Route as finishSignUpRoute } from './routes/finish-sign-up.js';
import { Route as verifyEmailRoute } from './routes/verify-email.js';

const routeTree = rootRoute.addChildren([
  indexRoute,
  verifyEmailRoute,
  finishSignUpRoute,
  authRoute.addChildren([signInRoute, signUpRoute, loginErrorRoute]),
  appRoute.addChildren([
    dashboardRoute,
    bucketsRoute,
    createBucketRoute,
    bucketDetailRoute,
    objectDetailRoute,
    uploadObjectRoute,
    apiKeysRoute,
    createApiKeyRoute,
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
