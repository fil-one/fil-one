import { createRouter } from '@tanstack/react-router';
import { parseSearch, stringifySearch } from './lib/search-params.js';
import { Route as rootRoute } from './routes/__root.js';
import { Route as indexRoute } from './routes/index.js';
import { Route as authRoute } from './routes/_auth.js';
import { Route as signInRoute } from './routes/_auth/sign-in.js';
import { Route as signUpRoute } from './routes/_auth/sign-up.js';
import { Route as loginErrorRoute } from './routes/_auth/login-error.js';
import { Route as appRoute } from './routes/_app.js';
import { Route as dashboardRoute } from './routes/_app/dashboard.js';
import { Route as getStartedRoute } from './routes/_app/get-started.js';
import { Route as bucketsRoute } from './routes/_app/buckets.js';
import { Route as createBucketRoute } from './routes/_app/buckets.create.js';
import { Route as bucketDetailRoute } from './routes/_app/buckets.$bucketName.js';
import { Route as objectDetailRoute } from './routes/_app/buckets.$bucketName.objects.$objectKey.js';
import { Route as uploadObjectRoute } from './routes/_app/buckets.$bucketName.upload.js';
import { Route as apiKeysRoute } from './routes/_app/api-keys.js';
import { Route as createApiKeyRoute } from './routes/_app/api-keys.create.js';
import { Route as billingRoute } from './routes/_app/billing.js';
import { Route as auditRoute } from './routes/_app/audit.js';
import { Route as membersRoute } from './routes/_app/members.js';
import { Route as editOrganizationRoute } from './routes/_app/edit-organization.js';
import { Route as organizationRoute } from './routes/_app/organization.js';
import { Route as settingsRoute } from './routes/_app/settings.js';
import { Route as supportRoute } from './routes/_app/support.js';
import { Route as bucketIntelligenceRoute } from './routes/_app/bucket-intelligence.js';
import { Route as aiAgentToolkitRoute } from './routes/_app/ai-agent-toolkit.js';
import { Route as verifyEmailRoute } from './routes/verify-email.js';
import { Route as createOrganizationRoute } from './routes/create-organization.js';
import { RouteErrorPage, RouteNotFoundPage } from './components/RouteRecoveryPage.js';
import { Route as accountDeletedRoute } from './routes/account-deleted.js';
import { Route as acceptInvitationRoute } from './routes/invite.accept.js';

const routeTree = rootRoute.addChildren([
  indexRoute,
  verifyEmailRoute,
  createOrganizationRoute,
  accountDeletedRoute,
  acceptInvitationRoute,
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
    auditRoute,
    membersRoute,
    editOrganizationRoute,
    organizationRoute,
    settingsRoute,
    supportRoute,
    bucketIntelligenceRoute,
    aiAgentToolkitRoute,
    getStartedRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  defaultErrorComponent: RouteErrorPage,
  defaultNotFoundComponent: RouteNotFoundPage,
  parseSearch,
  stringifySearch,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
