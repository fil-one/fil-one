/**
 * The `sst` module every handler test mocks:
 *
 * ```ts
 * vi.mock('sst', () => sstResourceMock());
 * ```
 *
 * Adding a resource is then one edit here rather than one per test file. Extra
 * or replacement resources go in the argument; a resource a second test needs
 * belongs in the list below.
 *
 * Its own file, and deliberately importing nothing: `vi.mock` factories are
 * hoisted above the imports, so a factory reaching a module that itself imports
 * `sst` reads that module's binding before it is initialized. A leaf module
 * cannot.
 */
export function sstResourceMock(resources: Record<string, unknown> = {}): {
  Resource: Record<string, unknown>;
} {
  return {
    Resource: {
      UserInfoTable: { name: 'UserInfoTable' },
      OrgTable: { name: 'OrgTable' },
      // The link is `AuditLog`, a narrowed wrapper around the table; the name it
      // carries is the table's own, which is what every TableName assertion
      // matches on.
      AuditLog: { name: 'AuditTable' },
      Auth0ClientId: { value: 'test-client-id' },
      Auth0ClientSecret: { value: 'test-client-secret' },
      Auth0MgmtClientId: { value: 'test-mgmt-client-id' },
      Auth0MgmtClientSecret: { value: 'test-mgmt-client-secret' },
      Auth0MgmtRuntimeClientId: { value: 'test-mgmt-runtime-client-id' },
      Auth0MgmtRuntimeClientSecret: { value: 'test-mgmt-runtime-client-secret' },
      AuroraBackofficeToken: { value: 'test-aurora-token' },
      HubSpotServiceKey: { value: 'test-hubspot-key' },
      ...resources,
    },
  };
}
