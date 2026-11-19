const OBJECT_REGIONS = ['eu-west-1', 'us-east-1'] as const;
export type RestrictionRegion = (typeof OBJECT_REGIONS)[number];
export interface RestrictionControlObject {
  bucket: string;
  key: string;
  sha256: string;
}
export interface RestrictionFixture {
  disposable: true;
  targetUserId: string;
  targetOrganizationId: string;
  controlUserId: string;
  controlOrganizationId: string;
  controlStorageState: string;
  objects: Record<RestrictionRegion, RestrictionControlObject>;
}

export function assertStagingRestrictionProof(stage: string): void {
  if (stage !== 'staging')
    throw new Error('Restriction isolation requires the bound SST staging stack');
}

export function assertDistinctTenantMappings(
  target: Record<RestrictionRegion, string | undefined>,
  control: Record<RestrictionRegion, string | undefined>,
): void {
  for (const region of OBJECT_REGIONS) {
    if (!target[region] || !control[region] || target[region] === control[region]) {
      throw new Error('Distinct provisioned target and control tenants required');
    }
  }
}

/** This opt-in proof names two disposable Organizations before any status change. */
export function parseRestrictionFixture(
  raw: string,
  disabledUserId: string,
  resetUserIds: readonly string[] = [],
): RestrictionFixture {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object') throw new Error('Invalid restriction fixture');
  const fixture = value as Partial<RestrictionFixture>;
  const isIdentity = (item: unknown): item is string =>
    typeof item === 'string' && /^[A-Za-z0-9_|-]{1,200}$/.test(item);
  if (
    fixture.disposable !== true ||
    !isIdentity(fixture.targetUserId) ||
    fixture.targetUserId !== disabledUserId ||
    !isIdentity(fixture.controlUserId) ||
    fixture.controlUserId === fixture.targetUserId ||
    resetUserIds.includes(fixture.controlUserId) ||
    !isIdentity(fixture.targetOrganizationId) ||
    !isIdentity(fixture.controlOrganizationId) ||
    fixture.targetOrganizationId === fixture.controlOrganizationId ||
    typeof fixture.controlStorageState !== 'string' ||
    !fixture.controlStorageState.trim() ||
    !fixture.objects ||
    typeof fixture.objects !== 'object'
  )
    throw new Error('Distinct disposable restriction fixtures required');
  validateControlObjects(fixture.objects);
  // Every field above is checked before returning the externally supplied shape.
  return fixture as RestrictionFixture;
}

function validateControlObjects(objects: RestrictionFixture['objects']): void {
  for (const region of OBJECT_REGIONS) {
    const object = objects[region];
    if (
      !object ||
      typeof object.bucket !== 'string' ||
      !object.bucket ||
      typeof object.key !== 'string' ||
      !object.key ||
      typeof object.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(object.sha256)
    ) {
      throw new Error('Existing control objects and SHA-256 digests required in Aurora and FTH');
    }
  }
}

/** Expired URLs cannot establish revocation, even when the provider returns 403. */
export function isUnexpired(expiresAt: string, now = Date.now()): boolean {
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) && now < expiry;
}
