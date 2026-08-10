import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { AccountDeletionWorkerPayload } from '../jobs/account-deletion-worker.js';

const lambda = new LambdaClient({});

/**
 * Event-invoke the account-deletion teardown worker (FIL-112).
 *
 * Its own module rather than a function on `account-deletion-start.ts` so a
 * handler that only needs to RE-drive an already-started teardown
 * (`create-deletion-challenge`) can call it without pulling in the member
 * snapshot, the deletion guards and the orchestrator registry that starting one
 * requires.
 *
 * The worker re-reads the DELETION record and re-applies the deletion guards at
 * the start of every pass, and every teardown it runs is idempotent, so calling
 * this repeatedly — or on an org whose teardown is already running — is safe.
 *
 * Callers need `ACCOUNT_DELETION_WORKER_FUNCTION_NAME` in their environment and
 * `lambda:InvokeFunction` on the worker; both are wired per route in
 * sst.config.ts.
 */
export async function invokeAccountDeletionWorker(orgId: string): Promise<void> {
  const payload: AccountDeletionWorkerPayload = { orgId };
  await lambda.send(
    new InvokeCommand({
      FunctionName: process.env.ACCOUNT_DELETION_WORKER_FUNCTION_NAME!,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
}
