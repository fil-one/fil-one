import assert from 'node:assert';
import {
  ConditionalCheckFailedException,
  GetItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { SSMClient, PutParameterCommand, GetParameterCommand } from '@aws-sdk/client-ssm';
import { getDynamoClient } from './ddb-client.js';
import { Resource } from 'sst';
import {
  createAuroraTenant,
  createAuroraTenantApiKey,
  DuplicateTokenNameError,
  setupAuroraTenant,
} from './aurora-backoffice.js';
import { ACCESS_KEY_PERMISSIONS } from '@filone/shared';
import { createAuroraAccessKey } from './aurora-portal.js';
import { reportMetric } from './metrics.js';
import { OrgSetupStatus, isOrgSetupComplete } from './org-setup-status.js';
import { scanAndEmitStuckTenantCount } from './stuck-tenant-metric.js';

export { OrgSetupStatus };

export interface TenantSetupOptions {
  orgId: string;
  orgName: string;
}

const dynamo = getDynamoClient();
const ssm = new SSMClient({});

type OrgProfileKey = {
  pk: { S: `ORG#${string}` };
  sk: { S: 'PROFILE' };
};

// Public entry point for synchronous tenant setup from request handlers.
// Returns the auroraTenantId once setup has reached AURORA_S3_ACCESS_KEY_CREATED.
// On any failure inside processTenantSetup, increments the per-org failure
// counter (best-effort) and re-throws so the handler can return a 503 to the
// user. The state machine resumes from whatever step is next on the user's
// retry.
export async function ensureTenantReady(
  options: TenantSetupOptions,
): Promise<{ auroraTenantId: string }> {
  try {
    await processTenantSetup(options);
  } catch (err) {
    try {
      await recordSetupFailure(options.orgId);
    } catch (counterErr) {
      console.error('[tenant-setup] failed to record setup failure', {
        orgId: options.orgId,
        error: counterErr,
      });
    }
    throw err;
  }

  const { Item } = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: { pk: { S: `ORG#${options.orgId}` }, sk: { S: 'PROFILE' } },
      ConsistentRead: true,
    }),
  );
  const auroraTenantId = Item?.auroraTenantId?.S;
  assert(auroraTenantId, `auroraTenantId missing after successful setup for org ${options.orgId}`);
  return { auroraTenantId };
}

export async function processTenantSetup(options: TenantSetupOptions): Promise<void> {
  const { orgId, orgName } = options;
  const orgProfileKey = {
    pk: { S: `ORG#${orgId}` },
    sk: { S: 'PROFILE' },
  } satisfies OrgProfileKey;

  const { Item } = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: orgProfileKey,
      // Strong consistency: a prior invocation may have advanced setupStatus
      // milliseconds ago. An eventually-consistent read could see the old
      // status and re-run a step that's already done, widening every race
      // window. ConditionalCheckFailedException on the subsequent write would
      // still keep us correct, but at the cost of wasted Aurora calls.
      ConsistentRead: true,
    }),
  );

  if (!Item) {
    throw new Error(`Org profile not found for org ${orgId}`);
  }

  const setupStatus = Item.setupStatus?.S;

  switch (setupStatus) {
    case OrgSetupStatus.AURORA_S3_ACCESS_KEY_CREATED:
      return;

    case OrgSetupStatus.AURORA_TENANT_API_KEY_CREATED: {
      const auroraTenantId = Item.auroraTenantId?.S;
      assert(auroraTenantId, `auroraTenantId missing in org profile for org ${orgId}`);
      await createAndStoreS3AccessKey(orgId, auroraTenantId, orgProfileKey);
      return;
    }

    case OrgSetupStatus.AURORA_TENANT_SETUP_COMPLETE: {
      const auroraTenantId = Item.auroraTenantId?.S;
      assert(auroraTenantId, `auroraTenantId missing in org profile for org ${orgId}`);
      await createAndStoreApiKey(orgId, auroraTenantId, orgProfileKey);
      await createAndStoreS3AccessKey(orgId, auroraTenantId, orgProfileKey);
      return;
    }

    case OrgSetupStatus.FILONE_ORG_CREATED: {
      const auroraTenantId = await createTenant(orgId, orgName, orgProfileKey);
      await runSetupAndMeasure(orgId, auroraTenantId, orgProfileKey);
      await createAndStoreApiKey(orgId, auroraTenantId, orgProfileKey);
      await createAndStoreS3AccessKey(orgId, auroraTenantId, orgProfileKey);
      return;
    }

    case OrgSetupStatus.AURORA_TENANT_CREATED: {
      const auroraTenantId = Item.auroraTenantId?.S;
      assert(auroraTenantId, `auroraTenantId missing in org profile for org ${orgId}`);
      await runSetup(orgId, auroraTenantId, orgProfileKey);
      await createAndStoreApiKey(orgId, auroraTenantId, orgProfileKey);
      await createAndStoreS3AccessKey(orgId, auroraTenantId, orgProfileKey);
      return;
    }

    default:
      throw new Error(`Unexpected setupStatus "${setupStatus}" for org ${orgId}`);
  }
}

async function createTenant(
  orgId: string,
  displayName: string,
  orgProfileKey: OrgProfileKey,
): Promise<string> {
  const { auroraTenantId } = await createAuroraTenant({ orgId, displayName });

  const result = await advanceStatus({
    orgProfileKey,
    expected: OrgSetupStatus.FILONE_ORG_CREATED,
    next: OrgSetupStatus.AURORA_TENANT_CREATED,
    writeAuroraTenantId: auroraTenantId,
  });

  if (result === 'lost-race') {
    // A concurrent invocation already wrote AURORA_TENANT_CREATED (or beyond)
    // and the winner's auroraTenantId is recorded on the org. Aurora's 409
    // handler in createAuroraTenant returns the same ID, but re-read here to
    // guarantee we use the persisted value rather than relying on that.
    const { Item } = await dynamo.send(
      new GetItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: orgProfileKey,
        ConsistentRead: true,
      }),
    );
    const persistedId = Item?.auroraTenantId?.S;
    assert(persistedId, `auroraTenantId missing after status-advance race for org ${orgId}`);
    return persistedId;
  }

  return auroraTenantId;
}

// Wraps runSetup to emit AuroraTenantSetupDuration. Called only from the
// FILONE_ORG_CREATED branch — that's the invocation that just won the
// createTenant transition and is the canonical "first attempt." Wall clock
// excludes the createTenant API call itself per the metric definition. A
// timeout still emits (the finally runs before the throw propagates), giving
// the metric a budget-valued spike when Aurora setup is taking longer than
// our poll budget.
async function runSetupAndMeasure(
  orgId: string,
  auroraTenantId: string,
  orgProfileKey: OrgProfileKey,
): Promise<void> {
  const start = performance.now();
  try {
    await runSetup(orgId, auroraTenantId, orgProfileKey);
  } finally {
    reportAuroraTenantSetupDuration(performance.now() - start);
  }
}

function reportAuroraTenantSetupDuration(durationMs: number): void {
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [[]],
          Metrics: [{ Name: 'AuroraTenantSetupDuration', Unit: 'Milliseconds' }],
        },
      ],
    },
    AuroraTenantSetupDuration: durationMs,
  });
}

// Aurora setup is reported as <1 s typical, <10 s p99. The schedule below
// gives 7 attempts over ~7.8 s of waits — short enough that the everyday case
// finishes inline well within a single Lambda invocation, and SQS retries
// pick up the rare tail. Calling setupAuroraTenant repeatedly is safe — it
// returns the current per-component state, not a new setup attempt.
const RUN_SETUP_POLL_BACKOFFS_MS = [100, 200, 500, 1000, 2000, 4000];

async function runSetup(
  orgId: string,
  auroraTenantId: string,
  orgProfileKey: OrgProfileKey,
): Promise<void> {
  let lastSetupStep: string | undefined;
  for (const wait of [0, ...RUN_SETUP_POLL_BACKOFFS_MS]) {
    if (wait > 0) await sleep(wait);
    ({ lastSetupStep } = await setupAuroraTenant({ tenantId: auroraTenantId }));
    if (lastSetupStep === 'FINISHED') break;
  }

  if (lastSetupStep !== 'FINISHED') {
    throw new Error(
      `Aurora tenant setup not finished for org ${orgId}: lastSetupStep=${lastSetupStep}`,
    );
  }

  await advanceStatus({
    orgProfileKey,
    expected: OrgSetupStatus.AURORA_TENANT_CREATED,
    next: OrgSetupStatus.AURORA_TENANT_SETUP_COMPLETE,
  });
}

async function createAndStoreApiKey(
  orgId: string,
  auroraTenantId: string,
  orgProfileKey: OrgProfileKey,
): Promise<void> {
  const stage = process.env.FILONE_STAGE!;
  const ssmName = `/filone/${stage}/aurora-portal/tenant-api-key/${auroraTenantId}`;

  let token: string;
  try {
    const result = await createAuroraTenantApiKey({ tenantId: auroraTenantId, orgId });
    token = result.token;
  } catch (err) {
    if (err instanceof DuplicateTokenNameError) {
      console.log(
        `Aurora tenant API token "filone-${orgId}" already exists for tenant ${auroraTenantId}, checking SSM`,
      );

      if (await ssmHasParameter(ssmName)) {
        // A previous attempt completed end-to-end; just advance status.
        await advanceStatus({
          orgProfileKey,
          expected: OrgSetupStatus.AURORA_TENANT_SETUP_COMPLETE,
          next: OrgSetupStatus.AURORA_TENANT_API_KEY_CREATED,
        });
        return;
      }

      // Aurora returned the token in the prior 201 response and Aurora doesn't
      // expose it again. Re-throw so SQS retries surface this to the DLQ;
      // operators need to delete the orphaned token in Aurora before retrying.
      throw err;
    }
    throw err;
  }

  await ssm.send(
    new PutParameterCommand({
      Name: ssmName,
      Value: token,
      Type: 'SecureString',
      Overwrite: true,
    }),
  );

  await advanceStatus({
    orgProfileKey,
    expected: OrgSetupStatus.AURORA_TENANT_SETUP_COMPLETE,
    next: OrgSetupStatus.AURORA_TENANT_API_KEY_CREATED,
  });
}

async function createAndStoreS3AccessKey(
  orgId: string,
  auroraTenantId: string,
  orgProfileKey: OrgProfileKey,
): Promise<void> {
  const stage = process.env.FILONE_STAGE!;

  let accessKeyId: string;
  let accessKeySecret: string;
  try {
    const result = await createAuroraAccessKey({
      tenantId: auroraTenantId,
      keyName: 'filone-console',
      permissions: [...ACCESS_KEY_PERMISSIONS],
    });
    accessKeyId = result.accessKeyId;
    accessKeySecret = result.accessKeySecret;
  } catch (err) {
    if ((err as { name?: string }).name === 'DuplicateKeyNameError') {
      console.log(
        `Aurora S3 access key "filone-console" already exists for tenant ${auroraTenantId}, checking SSM`,
      );

      const ssmName = `/filone/${stage}/aurora-s3/access-key/${auroraTenantId}`;
      if (!(await ssmHasParameter(ssmName))) {
        // Secret is lost — re-throw so the message goes to DLQ for manual investigation
        throw err;
      }

      await advanceStatus({
        orgProfileKey,
        expected: OrgSetupStatus.AURORA_TENANT_API_KEY_CREATED,
        next: OrgSetupStatus.AURORA_S3_ACCESS_KEY_CREATED,
      });
      return;
    }
    throw err;
  }

  await ssm.send(
    new PutParameterCommand({
      Name: `/filone/${stage}/aurora-s3/access-key/${auroraTenantId}`,
      Value: JSON.stringify({ accessKeyId, secretAccessKey: accessKeySecret }),
      Type: 'SecureString',
      Overwrite: true,
    }),
  );

  await advanceStatus({
    orgProfileKey,
    expected: OrgSetupStatus.AURORA_TENANT_API_KEY_CREATED,
    next: OrgSetupStatus.AURORA_S3_ACCESS_KEY_CREATED,
  });
}

type OrgSetupStatusValue = (typeof OrgSetupStatus)[keyof typeof OrgSetupStatus];

interface AdvanceStatusOptions {
  orgProfileKey: OrgProfileKey;
  expected: OrgSetupStatusValue;
  next: OrgSetupStatusValue;
  // When set, the conditional update also writes this value to the
  // auroraTenantId attribute. Only createTenant uses this. The attribute name
  // is hardcoded in the UpdateExpression so the expression stays a static
  // literal — no interpolated names that could turn into an injection vector
  // if a future caller piped user input through.
  writeAuroraTenantId?: string;
}

// Bounded poll budget for the duplicate-name recovery branches: one immediate
// check followed by retries on this backoff (~920 ms of waits total).
// Absorbs the narrow window where a concurrent invocation has written the
// credential to Aurora but hasn't yet written it to SSM, without waiting long
// enough to drag out the truly-lost case (where re-throwing into SQS retry →
// DLQ is the right outcome).
const SSM_POLL_BACKOFFS_MS = [20, 50, 100, 250, 500];

async function ssmHasParameter(name: string): Promise<boolean> {
  for (const wait of [0, ...SSM_POLL_BACKOFFS_MS]) {
    if (wait > 0) await sleep(wait);
    try {
      await ssm.send(new GetParameterCommand({ Name: name }));
      return true;
    } catch (err) {
      if ((err as { name?: string }).name !== 'ParameterNotFound') {
        throw err;
      }
    }
  }
  return false;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Increments the per-org failure counter atomically. When the count first
// crosses the stuck threshold (newCount === 3), kicks off a one-shot scan
// + EMF emission of StuckAuroraTenantSetupCount. Concurrent failing
// invocations are serialized by DynamoDB's atomic ADD: only one of them
// observes newCount === 3, so only one runs the scan.
export async function recordSetupFailure(orgId: string): Promise<void> {
  const out = await dynamo.send(
    new UpdateItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
      UpdateExpression: 'ADD setupFailureCount :one SET updatedAt = :now',
      ExpressionAttributeValues: {
        ':one': { N: '1' },
        ':now': { S: new Date().toISOString() },
      },
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  const newCount = Number(out.Attributes?.setupFailureCount?.N ?? '0');
  if (newCount === 3) {
    await scanAndEmitStuckTenantCount();
  }
}

async function advanceStatus(opts: AdvanceStatusOptions): Promise<'wrote' | 'lost-race'> {
  const isTerminal = isOrgSetupComplete(opts.next);

  const setExpr =
    opts.writeAuroraTenantId !== undefined
      ? 'SET auroraTenantId = :auroraTenantId, setupStatus = :status, updatedAt = :now'
      : 'SET setupStatus = :status, updatedAt = :now';
  const exprValues: Record<string, { S: string }> = {
    ':status': { S: opts.next },
    ':expected': { S: opts.expected },
    ':now': { S: new Date().toISOString() },
    ...(opts.writeAuroraTenantId !== undefined
      ? { ':auroraTenantId': { S: opts.writeAuroraTenantId } }
      : {}),
  };

  try {
    const out = await dynamo.send(
      new UpdateItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: opts.orgProfileKey,
        UpdateExpression: setExpr,
        ConditionExpression: 'setupStatus = :expected',
        ExpressionAttributeValues: exprValues,
        // On the terminal advance, read the prior setupFailureCount so we can
        // refresh the stuck-tenant gauge when this org was previously stuck.
        // The counter itself is left in place — it is a historical record of
        // attempts-to-success and is excluded from the gauge by the
        // setupStatus filter once terminal.
        ...(isTerminal ? { ReturnValues: 'ALL_OLD' as const } : {}),
      }),
    );

    if (isTerminal) {
      const priorFailureCount = Number(out.Attributes?.setupFailureCount?.N ?? '0');
      if (priorFailureCount >= 3) {
        await scanAndEmitStuckTenantCount();
      }
    }

    return 'wrote';
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      // A concurrent invocation already advanced past `expected`. Treat as
      // success at this step; the caller decides whether anything else needs
      // to happen (e.g. createTenant re-reads to fetch the winner's
      // auroraTenantId).
      return 'lost-race';
    }
    throw err;
  }
}
