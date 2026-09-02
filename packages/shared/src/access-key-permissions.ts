import { GRANULAR_PERMISSION_MAP } from './api/access-keys.js';
import type {
  AccessKeyPermission,
  GranularPermission,
  ObjectPermission,
} from './api/access-keys.js';
import { permissionsForRole, roleHasPermission } from './permissions.js';
import type { Permission } from './permissions.js';

/**
 * What a member must already hold to put a permission on a new access key.
 *
 * A SigV4 key is authority that leaves the console: once minted, it acts over
 * S3 with whatever it carries, and no role check runs on that path until M3.
 * The cap is therefore the whole of what keeps the console matrix from being
 * cosmetic — without it a Member denied `buckets.delete` in the console mints
 * a key and does it over S3 instead.
 *
 * Each key permission maps to the console permission that grants the same
 * capability: creating a bucket is `buckets.create`, deleting one is
 * `buckets.delete`, and reading a bucket's versioning or object-lock settings
 * is `buckets.read`. Mapping a capability to something stricter than its
 * console equivalent is not conservatism — it refuses a caller the thing they
 * demonstrably hold, and a Member who creates buckets every day would be
 * unable to mint a key that does it.
 */
export const ACCESS_KEY_PERMISSION_REQUIREMENT: Record<AccessKeyPermission, Permission> = {
  read: 'objects.read',
  list: 'objects.read',
  write: 'objects.write',
  delete: 'objects.delete',
  CreateBucket: 'buckets.create',
  DeleteBucket: 'buckets.delete',
  GetBucketVersioning: 'buckets.read',
  GetBucketObjectLockConfiguration: 'buckets.read',
};

/**
 * The data-protection granulars that need more than their parent.
 *
 * Writing retention or a legal hold is the one genuinely privileged thing on
 * this form: it is redeemed at the vendor, where its use cannot be audit-logged,
 * and it can make an object undeletable for years. Presign refuses the same two
 * operations for the same reason — no `putObjectRetention` op exists there — so
 * a key is the only way to reach them and the key needs `privileged.grant`,
 * which only an Owner holds. M2's privileged-operation flow (FIL-1019) replaces
 * this with a grant per operation.
 */
const GRANULAR_ELEVATIONS: Partial<Record<GranularPermission, Permission>> = {
  PutObjectRetention: 'privileged.grant',
  PutObjectLegalHold: 'privileged.grant',
};

/**
 * The same question for the data-protection granulars, derived rather than
 * written out: a granular is a narrowing of the object permission it hangs off,
 * so reading an object version needs what reading an object needs. Deriving it
 * from {@link GRANULAR_PERMISSION_MAP} means a granular added to that map
 * cannot arrive here with a requirement nobody chose. The exceptions are
 * {@link GRANULAR_ELEVATIONS}.
 */
export const GRANULAR_PERMISSION_REQUIREMENT: Record<GranularPermission, Permission> =
  Object.fromEntries(
    Object.entries(GRANULAR_PERMISSION_MAP).flatMap(([parent, granulars]) =>
      granulars.map((granular) => [
        granular,
        GRANULAR_ELEVATIONS[granular] ??
          ACCESS_KEY_PERMISSION_REQUIREMENT[parent as ObjectPermission],
      ]),
    ),
  ) as Record<GranularPermission, Permission>;

/** One requested key permission and the console permission it needs. */
export interface ExcessKeyPermission {
  /** The requested key permission, named as the caller wrote it. */
  keyPermission: string;
  /**
   * What the caller would have to hold to grant it, or undefined when the
   * value is not a key permission at all — nothing grants that.
   */
  requires?: Permission;
}

/**
 * The requested key permissions the actor's role cannot grant, in request
 * order, so a denial can name them.
 *
 * A value in neither table is refused rather than ignored. The schema rejects
 * unknown permissions long before this runs, so one arriving here means the
 * schema and this mapping have diverged, and the safe reading of "we do not
 * know what this grants" is that nobody may grant it.
 */
export function excessKeyPermissions(
  actorRole: string,
  request: {
    permissions: readonly string[];
    granularPermissions?: readonly string[];
  },
): ExcessKeyPermission[] {
  const held = new Set<Permission>(permissionsForRole(actorRole));

  const requested: ExcessKeyPermission[] = [
    ...request.permissions.map((keyPermission) => ({
      keyPermission,
      requires: requirementFor(keyPermission, ACCESS_KEY_PERMISSION_REQUIREMENT),
    })),
    ...(request.granularPermissions ?? []).map((keyPermission) => ({
      keyPermission,
      requires: requirementFor(keyPermission, GRANULAR_PERMISSION_REQUIREMENT),
    })),
  ];

  return requested.filter(({ requires }) => requires === undefined || !held.has(requires));
}

/**
 * The console permission a key permission needs, if it is one we know.
 *
 * The table's own keys are the membership test, so there is no second list to
 * keep in step with it. The own-property check keeps an inherited key such as
 * `'constructor'` from resolving to something that is not a permission —
 * `Object.hasOwn` semantics, spelled the ES2020 way because the console
 * compiles this file at that target.
 */
function requirementFor(
  keyPermission: string,
  table: Record<string, Permission>,
): Permission | undefined {
  return Object.prototype.hasOwnProperty.call(table, keyPermission)
    ? table[keyPermission]
    : undefined;
}

/**
 * What a key row records about the authority it carries.
 *
 * Both fields are optional because a row the console rebuilt after a vendor
 * 409 carries neither: the retry answers 409 with no secret, so the credential
 * was never handed to anyone and the console never learned what it holds.
 */
export interface StampedKeyPermissions {
  permissions?: readonly string[] | undefined;
  granularPermissions?: readonly string[] | undefined;
}

/**
 * Whether a key survives a role, and when it does not, why.
 *
 * `role_cannot_mint`: the role holds no `keys.create`, so it can hold no key.
 * `permissions_unrecorded`: the row records no permission set.
 * `exceeds_role`: the role could not grant everything the row carries.
 */
export type KeySurvival =
  | { survives: true }
  | { survives: false; reason: 'role_cannot_mint' | 'permissions_unrecorded' }
  | { survives: false; reason: 'exceeds_role'; excess: ExcessKeyPermission[] };

/**
 * Whether a key its holder already has survives that holder moving to `role`.
 *
 * One test, and the same one {@link excessKeyPermissions} applies at creation:
 * a key survives when its holder could mint it today. A role without
 * `keys.create` has an empty ceiling, so demotion to ReadOnly takes every key
 * the member created; a survivor there would have a holder who can neither see
 * nor revoke it, since `keys.manage_own` is what scopes the list and the
 * delete.
 *
 * A row recording no permission set cannot be placed inside the new role, so it
 * goes. Bucket scope is never compared: it is the creator's choice at mint time
 * and no role caps it.
 *
 * The caller decides whose keys to ask about. A row with no `createdBy` belongs
 * to nobody the console can name and is outside this rule entirely.
 */
export function keySurvival(role: string, key: StampedKeyPermissions): KeySurvival {
  if (!roleHasPermission(role, 'keys.create')) {
    return { survives: false, reason: 'role_cannot_mint' };
  }
  if (!key.permissions) return { survives: false, reason: 'permissions_unrecorded' };

  const excess = excessKeyPermissions(role, {
    permissions: key.permissions,
    granularPermissions: key.granularPermissions,
  });
  return excess.length === 0
    ? { survives: true }
    : { survives: false, reason: 'exceeds_role', excess };
}
