import type { SubscriptionStatus } from '@filone/shared';

/** UploadsTable — pk: USER#{userId}, sk: BUCKET#{name} */
export interface BucketRecord {
  pk: string;
  sk: string;
  name: string;
  region: string;
  createdAt: string;
  isPublic: boolean;
}

/** UploadsTable — pk: BUCKET#{userId}#{bucketName}, sk: OBJECT#{key} */
export interface ObjectRecord {
  pk: string;
  sk: string;
  key: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
  etag: string;
  s3Key: string;
  description?: string;
  cid?: string;
}

/** UserInfoTable — pk: ORG#{orgId}, sk: ACCESSKEY#{id} */
export interface AccessKeyRecord {
  pk: string;
  sk: string;
  keyName: string;
  accessKeyId: string;
  createdAt: string;
  status: string;
}

/** BillingTable — pk: CUSTOMER#{userId}, sk: SUBSCRIPTION */
export interface SubscriptionRecord {
  pk: string;
  sk: string;
  stripeCustomerId?: string;
  subscriptionStatus?: SubscriptionStatus;
  subscriptionId?: string;
  trialEndsAt?: string;
  gracePeriodEndsAt?: string;
  currentPeriodEnd?: string;
  canceledAt?: string;
  paymentMethodId?: string;
  paymentMethodLast4?: string;
  paymentMethodBrand?: string;
  paymentMethodExpMonth?: number;
  paymentMethodExpYear?: number;
  updatedAt?: string;
}
