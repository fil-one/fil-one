import { Resource } from 'sst';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { Role } from './roles.util.ts';

// Puts an E2E test account into the state a role rests in, through the
// stage's AccountStateTestHelper Lambda
// (packages/backend/src/jobs/account-state-test-helper.ts). The Lambda writes
// the org's billing row and syncs the tenant status in every provisioned
// region, so the suite never writes BillingTable rows itself.
//
// Role names double as state names. The e2e suite does not import workspace
// packages, so this union mirrors the Lambda's `AccountState`: the states the
// roles rest in, plus the grace period states that write-lock the tenants. Add
// a state to the Lambda before giving a role its name.

export type AccountState = Role | 'paid_grace_period' | 'trial_grace_period';

export interface AccountStateResult {
  orgId: string;
  subscriptionStatus: string;
  regions: Array<{ orchestratorId: string; tenantId: string; outcome: string }>;
}

/**
 * Test timeout for a setup step that changes an account's state. The Lambda
 * syncs every region with retries and may run for up to its own 120 s timeout,
 * and the step still has a login or bucket seeding to do after it.
 */
export const ACCOUNT_STATE_TIMEOUT_MS = 180_000;

const AWS_REGION = process.env.AWS_REGION ?? 'us-east-2';

export async function setAccountState(
  userId: string,
  state: AccountState,
): Promise<AccountStateResult> {
  const response = await getLambdaClient().send(
    new InvokeCommand({
      FunctionName: getFunctionName(),
      InvocationType: 'RequestResponse',
      Payload: JSON.stringify({ userId, state }),
    }),
  );
  const payload = response.Payload ? new TextDecoder().decode(response.Payload) : '';

  // A handler that throws still answers HTTP 200, with FunctionError set and the
  // error in the payload.
  if (response.FunctionError) {
    throw new Error(
      `AccountStateTestHelper failed to set user ${userId} to "${state}" ` +
        `(${response.FunctionError}): ${payload}`,
    );
  }
  return JSON.parse(payload) as AccountStateResult;
}

// The e2e tsconfig does not include the stage's generated sst-env.d.ts, so the
// Resource bindings are untyped here, as in the other e2e utils.
function getFunctionName(): string {
  return (Resource as unknown as Record<string, { name: string }>).AccountStateTestHelper.name;
}

let lambdaClient: LambdaClient | null = null;
function getLambdaClient(): LambdaClient {
  lambdaClient ??= new LambdaClient({ region: AWS_REGION });
  return lambdaClient;
}
