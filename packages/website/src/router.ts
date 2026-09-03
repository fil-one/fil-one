import { createRouter } from '@tanstack/react-router';
import { Route as rootRoute } from './routes/__root.js';
import { Route as indexRoute } from './routes/index.js';
import { Route as authRoute } from './routes/_auth.js';
import { Route as signInRoute } from './routes/_auth/sign-in.js';
import { Route as signUpRoute } from './routes/_auth/sign-up.js';
import { Route as loginErrorRoute } from './routes/_auth/login-error.js';
import { Route as appRoute } from './routes/_app.js';
import { Route as orgSlugRoute } from './routes/_app/$orgSlug.js';
import { Route as dashboardRoute } from './routes/_app/$orgSlug.dashboard.js';
import { Route as newOrgRoute } from './routes/_app/$orgSlug.new.js';
import { Route as bucketsRoute } from './routes/_app/$orgSlug.buckets.js';
import { Route as createBucketRoute } from './routes/_app/$orgSlug.buckets.create.js';
import { Route as bucketDetailRoute } from './routes/_app/$orgSlug.buckets.$bucketName.js';
import { Route as objectDetailRoute } from './routes/_app/$orgSlug.buckets.$bucketName.objects.$objectKey.js';
import { Route as uploadObjectRoute } from './routes/_app/$orgSlug.buckets.$bucketName.upload.js';
import { Route as apiKeysRoute } from './routes/_app/$orgSlug.api-keys.js';
import { Route as createApiKeyRoute } from './routes/_app/$orgSlug.api-keys.create.js';
import { Route as billingRoute } from './routes/_app/$orgSlug.billing.js';
import { Route as membersRoute } from './routes/_app/members.js';
import { Route as organizationRoute } from './routes/_app/$orgSlug.organization.js';
import { Route as settingsRoute } from './routes/_app/$orgSlug.settings.js';
import { Route as supportRoute } from './routes/_app/$orgSlug.support.js';
import { Route as bucketIntelligenceRoute } from './routes/_app/$orgSlug.bucket-intelligence.js';
import { Route as aiAgentToolkitRoute } from './routes/_app/$orgSlug.ai-agent-toolkit.js';
import { Route as verifyEmailRoute } from './routes/verify-email.js';
import { Route as welcomeRoute } from './routes/welcome.js';
import { RouteErrorPage, RouteNotFoundPage } from './components/RouteRecoveryPage.js';
import { Route as accountDeletedRoute } from './routes/account-deleted.js';
import { Route as acceptInvitationRoute } from './routes/invite.accept.js';
// Old flat paths (pre org-scoped URLs), kept as thin redirect stubs so
// bookmarks and emailed links still land somewhere — see each file's own
// comment for why it stays.
import { Route as legacyDashboardRoute } from './routes/_app/dashboard.js';
import { Route as legacyBucketsRoute } from './routes/_app/buckets.js';
import { Route as legacyCreateBucketRoute } from './routes/_app/buckets.create.js';
import { Route as legacyBucketDetailRoute } from './routes/_app/buckets.$bucketName.js';
import { Route as legacyObjectDetailRoute } from './routes/_app/buckets.$bucketName.objects.$objectKey.js';
import { Route as legacyUploadObjectRoute } from './routes/_app/buckets.$bucketName.upload.js';
import { Route as legacyApiKeysRoute } from './routes/_app/api-keys.js';
import { Route as legacyCreateApiKeyRoute } from './routes/_app/api-keys.create.js';
import { Route as legacyBillingRoute } from './routes/_app/billing.js';
import { Route as legacyOrganizationRoute } from './routes/_app/organization.js';
import { Route as legacySettingsRoute } from './routes/_app/settings.js';
import { Route as legacySupportRoute } from './routes/_app/support.js';
import { Route as legacyBucketIntelligenceRoute } from './routes/_app/bucket-intelligence.js';
import { Route as legacyAiAgentToolkitRoute } from './routes/_app/ai-agent-toolkit.js';
import { Route as legacyNewRoute } from './routes/_app/new.js';

const routeTree = rootRoute.addChildren([
  indexRoute,
  verifyEmailRoute,
  welcomeRoute,
  accountDeletedRoute,
  acceptInvitationRoute,
  authRoute.addChildren([signInRoute, signUpRoute, loginErrorRoute]),
  appRoute.addChildren([
    orgSlugRoute.addChildren([
      dashboardRoute,
      bucketsRoute,
      createBucketRoute,
      bucketDetailRoute,
      objectDetailRoute,
      uploadObjectRoute,
      apiKeysRoute,
      createApiKeyRoute,
      billingRoute,
      organizationRoute,
      settingsRoute,
      supportRoute,
      bucketIntelligenceRoute,
      aiAgentToolkitRoute,
      newOrgRoute,
    ]),
    membersRoute,
    legacyDashboardRoute,
    legacyBucketsRoute,
    legacyCreateBucketRoute,
    legacyBucketDetailRoute,
    legacyObjectDetailRoute,
    legacyUploadObjectRoute,
    legacyApiKeysRoute,
    legacyCreateApiKeyRoute,
    legacyBillingRoute,
    legacyOrganizationRoute,
    legacySettingsRoute,
    legacySupportRoute,
    legacyBucketIntelligenceRoute,
    legacyAiAgentToolkitRoute,
    legacyNewRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  defaultErrorComponent: RouteErrorPage,
  defaultNotFoundComponent: RouteNotFoundPage,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
